/**
 * Attendance. Percentages count present and late as 1, half-day as 0.5 and
 * absent as 0, over the days on which attendance was actually taken.
 */
import { z } from 'zod';
import { and, asc, eq, gte, inArray, lte, sql, desc } from 'drizzle-orm';
import { ATTENDANCE_STATUSES } from '@edumin/shared';
import { attendanceRecords, classes, enrollments, leaveRequests, roles, schools, sections, staffAttendance, staffProfiles, students, users } from '../../db/schema';
import { assertCanTeachSection, assertSectionAccess, assertStudentAccess, requirePermission, scopedStudentIds, ownStudentIds, type Ctx } from '../../core/context';
import { badRequest, forbidden, must } from '../../core/errors';
import { audience, notifyFamilies, notifyUsers } from '../../core/notify';
import { getSection } from '../academics/routes';
import { audit } from '../../core/audit';

export const ATTENDANCE_SCORE = sql<number>`case ${attendanceRecords.status} when 'present' then 1 when 'late' then 1 when 'half_day' then 0.5 else 0 end`;

const today = () => new Date().toISOString().slice(0, 10);

/** Students in a section with their mark for the day (or null). */
export async function getSheet(ctx: Ctx, sectionId: string, date: string) {
  requirePermission(ctx, 'attendance.view');
  await assertSectionAccess(ctx, sectionId);
  const sec = await getSection(ctx, sectionId);
  const rows = await ctx.db
    .select({
      studentId: students.id,
      admissionNo: students.admissionNo,
      firstName: students.firstName,
      lastName: students.lastName,
      photoUrl: students.photoUrl,
      rollNo: enrollments.rollNo,
      status: attendanceRecords.status,
      remarks: attendanceRecords.remarks,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .leftJoin(attendanceRecords, and(eq(attendanceRecords.studentId, students.id), eq(attendanceRecords.date, date)))
    .where(and(eq(enrollments.sectionId, sec.id), eq(enrollments.status, 'active'), eq(students.status, 'active')))
    .orderBy(asc(enrollments.rollNo), asc(students.firstName));
  const onLeave = await ctx.db
    .select({ studentId: leaveRequests.studentId })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.schoolId, ctx.schoolId),
        eq(leaveRequests.status, 'approved'),
        lte(leaveRequests.fromDate, date),
        gte(leaveRequests.toDate, date),
        rows.length ? inArray(leaveRequests.studentId, rows.map((r) => r.studentId)) : sql`false`,
      ),
    );
  const leaveSet = new Set(onLeave.map((l) => l.studentId));
  return { section: sec, date, isMarked: rows.some((r) => r.status), students: rows.map((r) => ({ ...r, onLeave: leaveSet.has(r.studentId) })) };
}

export const markInput = z.object({
  sectionId: z.uuid(),
  date: z.iso.date(),
  records: z
    .array(z.object({ studentId: z.uuid(), status: z.enum(ATTENDANCE_STATUSES), remarks: z.string().max(255).nullish() }))
    .min(1),
  notifyAbsent: z.boolean().default(true),
});

export async function markAttendance(ctx: Ctx, input: z.infer<typeof markInput>) {
  requirePermission(ctx, 'attendance.create');
  await assertCanTeachSection(ctx, input.sectionId);
  if (input.date > today()) throw badRequest('Attendance cannot be marked for a future date');
  const enrolled = await ctx.db
    .select({ id: enrollments.studentId })
    .from(enrollments)
    .where(and(eq(enrollments.sectionId, input.sectionId), inArray(enrollments.studentId, input.records.map((r) => r.studentId))));
  if (enrolled.length !== new Set(input.records.map((r) => r.studentId)).size) throw badRequest('Some students are not enrolled in this section');

  const existing = await ctx.db
    .select({ studentId: attendanceRecords.studentId, status: attendanceRecords.status })
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.sectionId, input.sectionId), eq(attendanceRecords.date, input.date)));
  const before = new Map(existing.map((e) => [e.studentId, e.status]));

  await ctx.db
    .insert(attendanceRecords)
    .values(input.records.map((r) => ({ schoolId: ctx.schoolId, sectionId: input.sectionId, date: input.date, studentId: r.studentId, status: r.status, remarks: r.remarks ?? null, markedBy: ctx.userId })))
    .onConflictDoUpdate({
      target: [attendanceRecords.studentId, attendanceRecords.date],
      set: { status: sql`excluded.status`, remarks: sql`excluded.remarks`, markedBy: ctx.userId, sectionId: sql`excluded.section_id` },
    });

  // Alert parents only for newly-absent students, so re-saving doesn't spam.
  if (input.notifyAbsent) {
    const newlyAbsent = input.records.filter((r) => r.status === 'absent' && before.get(r.studentId) !== 'absent').map((r) => r.studentId);
    for (const sid of newlyAbsent) {
      const [s] = await ctx.db.select({ firstName: students.firstName, lastName: students.lastName }).from(students).where(eq(students.id, sid));
      await notifyFamilies(ctx.db, ctx.schoolId, [sid], {
        type: 'attendance_alert',
        title: `${s.firstName} ${s.lastName} was marked absent`,
        body: `Attendance for ${input.date}. Please contact the school if this is unexpected.`,
        link: '/attendance',
        event: 'attendance_absent',
        vars: { date: new Date(input.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) },
        who: { parents: true },
        createdBy: ctx.userId,
      });
    }
  }
  const counts = Object.fromEntries(ATTENDANCE_STATUSES.map((s) => [s, input.records.filter((r) => r.status === s).length]));
  await audit(ctx, 'mark', 'attendance', input.sectionId, { date: input.date, ...counts });
  return counts;
}

/** Per-student totals for a date range, filtered by section or explicit students. */
export async function attendanceStats(ctx: Ctx, f: { from: string; to: string; sectionId?: string | null; classId?: string | null; studentIds?: string[] | null; academicYearId?: string | null }) {
  const scoped = await scopedStudentIds(ctx);
  const where = and(
    eq(attendanceRecords.schoolId, ctx.schoolId),
    gte(attendanceRecords.date, f.from),
    lte(attendanceRecords.date, f.to),
    f.sectionId ? eq(attendanceRecords.sectionId, f.sectionId) : undefined,
    f.classId ? eq(sections.classId, f.classId) : undefined,
    f.studentIds ? inArray(attendanceRecords.studentId, f.studentIds.length ? f.studentIds : ['00000000-0000-0000-0000-000000000000']) : undefined,
    scoped ? inArray(attendanceRecords.studentId, scoped.length ? scoped : ['00000000-0000-0000-0000-000000000000']) : undefined,
  );
  return ctx.db
    .select({
      studentId: students.id,
      admissionNo: students.admissionNo,
      name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
      className: classes.name,
      sectionName: sections.name,
      sectionId: sections.id,
      total: sql<number>`count(*)::int`,
      present: sql<number>`count(*) filter (where ${attendanceRecords.status} = 'present')::int`,
      absent: sql<number>`count(*) filter (where ${attendanceRecords.status} = 'absent')::int`,
      late: sql<number>`count(*) filter (where ${attendanceRecords.status} = 'late')::int`,
      halfDay: sql<number>`count(*) filter (where ${attendanceRecords.status} = 'half_day')::int`,
      percentage: sql<number>`round(100.0 * sum(${ATTENDANCE_SCORE}) / nullif(count(*),0), 1)::float`,
    })
    .from(attendanceRecords)
    .innerJoin(students, eq(students.id, attendanceRecords.studentId))
    .innerJoin(sections, eq(sections.id, attendanceRecords.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(where)
    .groupBy(students.id, classes.name, classes.level, sections.name, sections.id)
    .orderBy(asc(classes.level), asc(sections.name), asc(students.firstName));
}

/** Month view: per-student per-day matrix for a section. */
export async function monthlyRegister(ctx: Ctx, sectionId: string, month: string) {
  requirePermission(ctx, 'attendance.view');
  await assertSectionAccess(ctx, sectionId);
  const from = `${month}-01`;
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  const to = end.toISOString().slice(0, 10);
  const sheet = await getSheet(ctx, sectionId, from);
  const records = await ctx.db
    .select({ studentId: attendanceRecords.studentId, date: attendanceRecords.date, status: attendanceRecords.status })
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.sectionId, sectionId), gte(attendanceRecords.date, from), lte(attendanceRecords.date, to)));
  const stats = await attendanceStats(ctx, { from, to, sectionId });
  const statMap = new Map(stats.map((s) => [s.studentId, s]));
  const byStudent = new Map<string, Record<string, string>>();
  for (const r of records) {
    if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, {});
    byStudent.get(r.studentId)![r.date] = r.status;
  }
  const days = [...new Set(records.map((r) => r.date))].sort();
  return {
    month,
    days,
    daysInMonth: end.getUTCDate(),
    students: sheet.students.map((s) => ({ ...s, days: byStudent.get(s.studentId) ?? {}, stats: statMap.get(s.studentId) ?? null })),
  };
}

export async function studentAttendance(ctx: Ctx, studentId: string, from: string, to: string) {
  requirePermission(ctx, 'attendance.view');
  await assertStudentAccess(ctx, studentId);
  const records = await ctx.db
    .select({ date: attendanceRecords.date, status: attendanceRecords.status, remarks: attendanceRecords.remarks })
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.studentId, studentId), gte(attendanceRecords.date, from), lte(attendanceRecords.date, to)))
    .orderBy(desc(attendanceRecords.date));
  const [stats] = await attendanceStats(ctx, { from, to, studentIds: [studentId] });
  const monthly = await ctx.db
    .select({
      month: sql<string>`to_char(${attendanceRecords.date}::date, 'YYYY-MM')`,
      percentage: sql<number>`round(100.0 * sum(${ATTENDANCE_SCORE}) / nullif(count(*),0), 1)::float`,
      total: sql<number>`count(*)::int`,
    })
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.studentId, studentId), gte(attendanceRecords.date, from), lte(attendanceRecords.date, to)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return { records, stats: stats ?? null, monthly };
}

export async function lowAttendance(ctx: Ctx, f: { from: string; to: string; threshold?: number; sectionId?: string | null; classId?: string | null }) {
  requirePermission(ctx, 'attendance.view');
  let threshold = f.threshold;
  if (threshold === undefined) {
    const [s] = await ctx.db.select({ settings: schools.settings }).from(schools).where(eq(schools.id, ctx.schoolId));
    threshold = s.settings.lowAttendanceThreshold;
  }
  const stats = await attendanceStats(ctx, f);
  return { threshold, students: stats.filter((s) => s.percentage < threshold!) };
}

export async function sendLowAttendanceAlerts(ctx: Ctx, f: { from: string; to: string; threshold?: number; sectionId?: string | null }) {
  requirePermission(ctx, 'attendance.edit');
  const { threshold, students: list } = await lowAttendance(ctx, f);
  let sent = 0;
  for (const s of list) {
    const res = await notifyFamilies(ctx.db, ctx.schoolId, [s.studentId], {
      type: 'attendance_alert',
      title: `Low attendance: ${s.name} (${s.percentage}%)`,
      body: `Attendance between ${f.from} and ${f.to} is below the required ${threshold}%.`,
      link: '/attendance',
      event: 'attendance_low',
      vars: { percent: `${s.percentage}%`, threshold: `${threshold}%` },
      createdBy: ctx.userId,
    });
    sent += res?.queued ?? 0;
  }
  return { students: list.length, notified: sent };
}

// ── Staff attendance ──

export async function staffSheet(ctx: Ctx, date: string) {
  requirePermission(ctx, 'staff.view');
  return ctx.db
    .select({
      userId: users.id,
      fullName: users.fullName,
      roleName: roles.name,
      designation: staffProfiles.designation,
      status: staffAttendance.status,
      remarks: staffAttendance.remarks,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .leftJoin(staffAttendance, and(eq(staffAttendance.userId, users.id), eq(staffAttendance.date, date)))
    .where(and(eq(users.schoolId, ctx.schoolId), eq(users.isActive, true), sql`${roles.key} not in ('student','parent')`))
    .orderBy(asc(users.fullName));
}

export const staffMarkInput = z.object({
  date: z.iso.date(),
  records: z.array(z.object({ userId: z.uuid(), status: z.enum(ATTENDANCE_STATUSES), remarks: z.string().max(255).nullish() })).min(1),
});

export async function markStaff(ctx: Ctx, input: z.infer<typeof staffMarkInput>) {
  requirePermission(ctx, 'staff.edit');
  if (input.date > today()) throw badRequest('Cannot mark a future date');
  const valid = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.schoolId, ctx.schoolId), inArray(users.id, input.records.map((r) => r.userId))));
  if (valid.length !== new Set(input.records.map((r) => r.userId)).size) throw badRequest('Unknown staff member');
  await ctx.db
    .insert(staffAttendance)
    .values(input.records.map((r) => ({ schoolId: ctx.schoolId, userId: r.userId, date: input.date, status: r.status, remarks: r.remarks ?? null, markedBy: ctx.userId })))
    .onConflictDoUpdate({ target: [staffAttendance.userId, staffAttendance.date], set: { status: sql`excluded.status`, remarks: sql`excluded.remarks`, markedBy: ctx.userId } });
  return { saved: input.records.length };
}

// ── Leave ──

export const leaveInput = z
  .object({
    studentId: z.uuid().nullish(),
    fromDate: z.iso.date(),
    toDate: z.iso.date(),
    type: z.string().trim().max(30).default('casual'),
    reason: z.string().trim().min(3).max(1000),
  })
  .refine((v) => v.toDate >= v.fromDate, { message: 'End date must be on or after start date', path: ['toDate'] });

export async function applyLeave(ctx: Ctx, input: z.infer<typeof leaveInput>) {
  requirePermission(ctx, 'leave.create');
  let studentId = input.studentId ?? null;
  if (ctx.scope === 'own' && !studentId) {
    // Students apply for themselves; a parent with one child needn't choose.
    const own = await ownStudentIds(ctx);
    if (own.length === 1) studentId = own[0];
  }
  if (studentId) {
    if (ctx.scope === 'own' && !(await ownStudentIds(ctx)).includes(studentId)) throw forbidden();
  } else if (ctx.scope === 'own') {
    throw badRequest('Choose the student this leave is for');
  }
  const [row] = await ctx.db.insert(leaveRequests).values({ ...input, studentId, schoolId: ctx.schoolId, requesterId: ctx.userId }).returning();
  // Student leave → class teacher; staff leave → admins/principal.
  let approvers: string[] = [];
  if (studentId) {
    const [sec] = await ctx.db
      .select({ teacher: sections.classTeacherId })
      .from(enrollments)
      .innerJoin(sections, eq(sections.id, enrollments.sectionId))
      .where(and(eq(enrollments.studentId, studentId), eq(enrollments.status, 'active')))
      .limit(1);
    if (sec?.teacher) approvers = [sec.teacher];
  } else {
    approvers = await audience.byRoleKeys(ctx.db, ctx.schoolId, ['school_admin', 'principal']);
  }
  await notifyUsers(ctx.db, ctx.schoolId, approvers, { type: 'leave_request', title: 'New leave request', body: `${input.fromDate} → ${input.toDate}: ${input.reason}`, link: '/attendance?tab=leave' });
  return row;
}

export async function listLeave(ctx: Ctx, f: { status?: string; mine?: boolean }) {
  requirePermission(ctx, 'leave.view');
  const conds = [eq(leaveRequests.schoolId, ctx.schoolId), f.status ? eq(leaveRequests.status, f.status) : undefined];
  if (f.mine || ctx.scope === 'own') {
    const own = await ownStudentIds(ctx);
    conds.push(own.length ? sql`(${leaveRequests.requesterId} = ${ctx.userId} or ${inArray(leaveRequests.studentId, own)})` : eq(leaveRequests.requesterId, ctx.userId));
  } else if (ctx.scope === 'assigned') {
    // Teachers: their own leave plus student leave in their sections.
    const studs = await scopedStudentIds(ctx);
    conds.push(studs && studs.length ? sql`(${leaveRequests.requesterId} = ${ctx.userId} or ${inArray(leaveRequests.studentId, studs)})` : eq(leaveRequests.requesterId, ctx.userId));
  }
  return ctx.db
    .select({
      leave: leaveRequests,
      requesterName: users.fullName,
      studentName: sql<string | null>`${students.firstName} || ' ' || ${students.lastName}`,
      admissionNo: students.admissionNo,
    })
    .from(leaveRequests)
    .innerJoin(users, eq(users.id, leaveRequests.requesterId))
    .leftJoin(students, eq(students.id, leaveRequests.studentId))
    .where(and(...conds))
    .orderBy(desc(leaveRequests.createdAt))
    .limit(200)
    .then((rows) => rows.map((r) => ({ ...r.leave, requesterName: r.requesterName, studentName: r.studentName, admissionNo: r.admissionNo })));
}

export async function reviewLeave(ctx: Ctx, id: string, body: { status: 'approved' | 'rejected' | 'cancelled'; note?: string | null }) {
  const [l] = await ctx.db.select().from(leaveRequests).where(and(eq(leaveRequests.id, id), eq(leaveRequests.schoolId, ctx.schoolId)));
  must(l, 'Leave request');
  if (body.status === 'cancelled') {
    if (l.requesterId !== ctx.userId) throw forbidden('Only the requester can cancel');
  } else {
    requirePermission(ctx, 'leave.approve');
    if (l.studentId) await assertStudentAccess(ctx, l.studentId);
    else if (ctx.scope !== 'school') throw forbidden('Only administrators can approve staff leave');
    if (l.requesterId === ctx.userId) throw forbidden('You cannot approve your own leave');
  }
  if (l.status !== 'pending') throw badRequest('This request has already been processed');
  const [row] = await ctx.db
    .update(leaveRequests)
    .set({ status: body.status, reviewNote: body.note ?? null, reviewedBy: ctx.userId, reviewedAt: new Date() })
    .where(eq(leaveRequests.id, id))
    .returning();
  if (body.status !== 'cancelled') {
    await notifyUsers(ctx.db, ctx.schoolId, [l.requesterId], { type: 'leave_update', title: `Leave request ${body.status}`, body: `${l.fromDate} → ${l.toDate}${body.note ? ': ' + body.note : ''}`, link: '/attendance?tab=leave' });
  }
  return row;
}
