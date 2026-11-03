/** Role-specific dashboards. Every number here is computed live from the database. */
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  academicYears,
  admissionApplications,
  admissionEnquiries,
  assignments,
  attendanceRecords,
  classes,
  enrollments,
  examPapers,
  exams,
  feeInvoices,
  leaveRequests,
  meetings,
  payments,
  roles,
  sections,
  sectionSubjects,
  students,
  subjects,
  submissions,
  users,
} from '../../db/schema';
import { can, currentYearId, ownStudentIds, teacherSectionIds, type Ctx } from '../../core/context';
import { ATTENDANCE_SCORE } from '../attendance/service';
import { BALANCE } from '../fees/service';
import { computeResults } from '../exams/service';
import { listEvents } from '../events/routes';
import { listAnnouncements } from '../communication/routes';
import { teacherDay } from '../timetable/service';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFrom = (n: number) => iso(new Date(Date.now() + n * 86400_000));
const has = (ctx: Ctx, f: string) => ctx.features.has(f);
const NONE = ['00000000-0000-0000-0000-000000000000'];

async function attendanceTrend(ctx: Ctx, days: number, sectionIds?: string[]) {
  return ctx.db
    .select({ date: attendanceRecords.date, percentage: sql<number>`round(100.0 * sum(${ATTENDANCE_SCORE}) / nullif(count(*),0), 1)::float` })
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.schoolId, ctx.schoolId), gte(attendanceRecords.date, daysFrom(-days)), sectionIds ? inArray(attendanceRecords.sectionId, sectionIds.length ? sectionIds : NONE) : undefined))
    .groupBy(attendanceRecords.date)
    .orderBy(asc(attendanceRecords.date));
}

async function feeTrend(ctx: Ctx, months: number) {
  return ctx.db
    .select({ month: sql<string>`to_char(date_trunc('month', ${payments.paidAt}), 'Mon YY')`, key: sql<string>`to_char(date_trunc('month', ${payments.paidAt}), 'YYYY-MM')`, amount: sql<number>`sum(${payments.amount})::float` })
    .from(payments)
    .where(and(eq(payments.schoolId, ctx.schoolId), eq(payments.status, 'completed'), sql`${payments.paidAt} > date_trunc('month', now()) - make_interval(months => ${months - 1})`))
    .groupBy(sql`1, 2`)
    .orderBy(sql`2`);
}

async function upcomingExams(ctx: Ctx, classIds?: string[]) {
  return ctx.db
    .select({ id: exams.id, name: exams.name, startDate: exams.startDate, endDate: exams.endDate, status: exams.status, papers: sql<number>`count(${examPapers.id})::int` })
    .from(exams)
    .innerJoin(examPapers, eq(examPapers.examId, exams.id))
    .where(and(eq(exams.schoolId, ctx.schoolId), sql`${exams.status} in ('scheduled','marks_entry')`, gte(examPapers.date, iso(new Date())), classIds ? inArray(examPapers.classId, classIds.length ? classIds : NONE) : undefined))
    .groupBy(exams.id)
    .orderBy(asc(exams.startDate))
    .limit(5);
}

/** Summary of the most recent published exam (optionally limited to some sections). */
async function latestPerformance(ctx: Ctx, sectionIds?: string[]) {
  const yearId = await currentYearId(ctx);
  const [exam] = await ctx.db
    .select()
    .from(exams)
    .where(and(eq(exams.schoolId, ctx.schoolId), eq(exams.status, 'published')))
    .orderBy(sql`${exams.academicYearId} = ${yearId} desc`, desc(exams.approvedAt))
    .limit(1);
  if (!exam) return null;
  const { results } = await computeResults(ctx, exam.id);
  const rel = results.filter((r) => r.percentage !== null && (!sectionIds || sectionIds.includes(r.sectionId)));
  if (!rel.length) return { examId: exam.id, examName: exam.name, average: null, passRate: null, byClass: [] };
  const byClass = new Map<string, { label: string; level: number; sum: number; n: number }>();
  for (const r of rel) {
    const key = sectionIds ? `${r.className} - ${r.sectionName}` : r.className;
    const g = byClass.get(key) ?? { label: key, level: Number(r.className.replace(/\D/g, '')) || 0, sum: 0, n: 0 };
    g.sum += r.percentage!;
    g.n++;
    byClass.set(key, g);
  }
  return {
    examId: exam.id,
    examName: exam.name,
    average: Math.round((rel.reduce((a, r) => a + r.percentage!, 0) / rel.length) * 10) / 10,
    passRate: Math.round((rel.filter((r) => r.passed).length / rel.length) * 1000) / 10,
    byClass: [...byClass.values()].sort((a, b) => a.level - b.level || a.label.localeCompare(b.label)).map((g) => ({ label: g.label, average: Math.round((g.sum / g.n) * 10) / 10 })),
  };
}

export async function adminDashboard(ctx: Ctx) {
  const today = iso(new Date());
  const monthStart = today.slice(0, 8) + '01';
  const yearId = await currentYearId(ctx);
  const [[stu], [tch], att, [sec]] = await Promise.all([
    ctx.db.select({ n: sql<number>`count(*)::int`, male: sql<number>`count(*) filter (where gender='male')::int`, female: sql<number>`count(*) filter (where gender='female')::int` }).from(students).where(and(eq(students.schoolId, ctx.schoolId), eq(students.status, 'active'))),
    ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.schoolId, ctx.schoolId), eq(users.isActive, true), eq(roles.key, 'teacher'))),
    ctx.db
      .select({
        marked: sql<number>`count(*)::int`,
        present: sql<number>`count(*) filter (where ${attendanceRecords.status} in ('present','late'))::int`,
        absent: sql<number>`count(*) filter (where ${attendanceRecords.status} = 'absent')::int`,
        sectionsMarked: sql<number>`count(distinct ${attendanceRecords.sectionId})::int`,
        percentage: sql<number | null>`round(100.0 * sum(${ATTENDANCE_SCORE}) / nullif(count(*),0), 1)::float`,
      })
      .from(attendanceRecords)
      .where(and(eq(attendanceRecords.schoolId, ctx.schoolId), eq(attendanceRecords.date, today))),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(sections).where(and(eq(sections.schoolId, ctx.schoolId), yearId ? eq(sections.academicYearId, yearId) : sql`false`)),
  ]);

  const out: Record<string, unknown> = {
    kind: 'admin',
    totals: { students: stu.n, male: stu.male, female: stu.female, teachers: tch.n, sections: sec.n },
    attendanceToday: { ...att[0], sectionsTotal: sec.n },
  };

  if (has(ctx, 'fees') && can(ctx, 'fees.view')) {
    const [[month], [todayCol], [dues]] = await Promise.all([
      ctx.db.select({ amount: sql<number>`coalesce(sum(${payments.amount}),0)::float` }).from(payments).where(and(eq(payments.schoolId, ctx.schoolId), eq(payments.status, 'completed'), gte(payments.paidAt, new Date(monthStart)))),
      ctx.db.select({ amount: sql<number>`coalesce(sum(${payments.amount}),0)::float` }).from(payments).where(and(eq(payments.schoolId, ctx.schoolId), eq(payments.status, 'completed'), gte(payments.paidAt, new Date(today)))),
      ctx.db
        .select({ outstanding: sql<number>`coalesce(sum(${BALANCE}),0)::float`, overdue: sql<number>`coalesce(sum(${BALANCE}) filter (where ${feeInvoices.dueDate} < ${today}),0)::float` })
        .from(feeInvoices)
        .where(and(eq(feeInvoices.schoolId, ctx.schoolId), inArray(feeInvoices.status, ['unpaid', 'partial']))),
    ]);
    out.fees = { collectedThisMonth: month.amount, collectedToday: todayCol.amount, outstanding: dues.outstanding, overdue: dues.overdue, trend: await feeTrend(ctx, 6) };
  }
  if (has(ctx, 'admissions') && can(ctx, 'admissions.view')) {
    const [[enq], [apps]] = await Promise.all([
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(admissionEnquiries).where(and(eq(admissionEnquiries.schoolId, ctx.schoolId), eq(admissionEnquiries.status, 'new'))),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(admissionApplications).where(and(eq(admissionApplications.schoolId, ctx.schoolId), inArray(admissionApplications.status, ['submitted', 'under_review']))),
    ]);
    out.admissions = { newEnquiries: enq.n, pendingApplications: apps.n };
  }
  if (has(ctx, 'attendance')) out.attendanceTrend = await attendanceTrend(ctx, 21);
  if (has(ctx, 'exams')) {
    out.upcomingExams = await upcomingExams(ctx);
    out.performance = await latestPerformance(ctx);
  }
  if (has(ctx, 'events')) out.upcomingEvents = (await listEvents(ctx, today, daysFrom(45))).slice(0, 6);
  const [leave] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(leaveRequests).where(and(eq(leaveRequests.schoolId, ctx.schoolId), eq(leaveRequests.status, 'pending')));
  out.pendingLeave = leave.n;
  return out;
}

export async function teacherDashboard(ctx: Ctx) {
  const today = iso(new Date());
  const yearId = await currentYearId(ctx);
  const secIds = await teacherSectionIds(ctx);
  const mySections = secIds.length
    ? await ctx.db
        .select({
          id: sections.id,
          label: sql<string>`${classes.name} || ' - ' || ${sections.name}`,
          classId: sections.classId,
          isClassTeacher: sql<boolean>`${sections.classTeacherId} = ${ctx.userId}`,
          students: sql<number>`(select count(*)::int from ${enrollments} where ${enrollments.sectionId} = ${sections.id} and ${enrollments.status} = 'active')`,
          markedToday: sql<boolean>`exists (select 1 from ${attendanceRecords} where ${attendanceRecords.sectionId} = ${sections.id} and ${attendanceRecords.date} = ${today})`,
          subjects: sql<string | null>`(select string_agg(${subjects.name}, ', ') from ${sectionSubjects} join ${subjects} on ${subjects.id} = ${sectionSubjects.subjectId} where ${sectionSubjects.sectionId} = ${sections.id} and ${sectionSubjects.teacherId} = ${ctx.userId})`,
        })
        .from(sections)
        .innerJoin(classes, eq(classes.id, sections.classId))
        .where(and(inArray(sections.id, secIds), yearId ? eq(sections.academicYearId, yearId) : undefined))
        .orderBy(asc(classes.level), asc(sections.name))
    : [];
  const classIds = [...new Set(mySections.map((s) => s.classId))];
  const out: Record<string, unknown> = {
    kind: 'teacher',
    sections: mySections,
    totals: { sections: mySections.length, students: mySections.reduce((a, s) => a + s.students, 0), classTeacherOf: mySections.filter((s) => s.isClassTeacher).length },
  };
  if (has(ctx, 'timetable')) out.today = await teacherDay(ctx, ctx.userId, today);
  if (has(ctx, 'homework')) {
    out.homework = await ctx.db
      .select({
        id: assignments.id,
        title: assignments.title,
        dueDate: assignments.dueDate,
        sectionLabel: sql<string>`(select c.name || ' - ' || s.name from sections s join classes c on c.id = s.class_id where s.id = ${assignments.sectionId})`,
        submitted: sql<number>`(select count(*)::int from ${submissions} where ${submissions.assignmentId} = ${assignments.id})`,
        toGrade: sql<number>`(select count(*)::int from ${submissions} where ${submissions.assignmentId} = ${assignments.id} and ${submissions.status} <> 'graded')`,
      })
      .from(assignments)
      .where(and(eq(assignments.schoolId, ctx.schoolId), eq(assignments.teacherId, ctx.userId)))
      .orderBy(desc(assignments.dueDate))
      .limit(6);
  }
  if (has(ctx, 'exams')) {
    out.upcomingExams = await upcomingExams(ctx, classIds);
    out.performance = await latestPerformance(ctx, secIds);
  }
  if (has(ctx, 'attendance')) out.attendanceTrend = await attendanceTrend(ctx, 14, secIds);
  const [leave] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(leaveRequests)
    .innerJoin(enrollments, and(eq(enrollments.studentId, leaveRequests.studentId), eq(enrollments.status, 'active')))
    .where(and(eq(leaveRequests.schoolId, ctx.schoolId), eq(leaveRequests.status, 'pending'), inArray(enrollments.sectionId, secIds.length ? secIds : NONE)));
  out.pendingLeave = leave.n;
  if (has(ctx, 'meetings')) out.meetings = await upcomingMeetings(ctx, eq(meetings.teacherId, ctx.userId));
  return out;
}

async function upcomingMeetings(ctx: Ctx, who: ReturnType<typeof eq>) {
  return ctx.db
    .select({
      id: meetings.id,
      startsAt: meetings.startsAt,
      status: meetings.status,
      location: meetings.location,
      teacherName: users.fullName,
      studentName: sql<string | null>`(select first_name || ' ' || last_name from students where id = ${meetings.studentId})`,
    })
    .from(meetings)
    .innerJoin(users, eq(users.id, meetings.teacherId))
    .where(and(eq(meetings.schoolId, ctx.schoolId), who, inArray(meetings.status, ['requested', 'approved']), gte(meetings.endsAt, new Date())))
    .orderBy(asc(meetings.startsAt))
    .limit(5);
}

/** Parent and student dashboards: one card per child. */
export async function familyDashboard(ctx: Ctx) {
  const today = iso(new Date());
  const yearId = await currentYearId(ctx);
  const [year] = yearId ? await ctx.db.select().from(academicYears).where(eq(academicYears.id, yearId)) : [];
  const own = await ownStudentIds(ctx);
  const children = [];
  for (const sid of own) {
    const [s] = await ctx.db
      .select({
        id: students.id,
        name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
        admissionNo: students.admissionNo,
        photoUrl: students.photoUrl,
        sectionId: sections.id,
        classLabel: sql<string>`${classes.name} || ' - ' || ${sections.name}`,
        classTeacher: sql<string | null>`(select full_name from users where id = ${sections.classTeacherId})`,
      })
      .from(students)
      .leftJoin(enrollments, and(eq(enrollments.studentId, students.id), yearId ? eq(enrollments.academicYearId, yearId) : sql`false`))
      .leftJoin(sections, eq(sections.id, enrollments.sectionId))
      .leftJoin(classes, eq(classes.id, sections.classId))
      .where(eq(students.id, sid));
    const child: Record<string, unknown> = { ...s };
    if (has(ctx, 'attendance') && year) {
      const [a] = await ctx.db
        .select({
          percentage: sql<number | null>`round(100.0 * sum(${ATTENDANCE_SCORE}) / nullif(count(*),0), 1)::float`,
          days: sql<number>`count(*)::int`,
          absent: sql<number>`count(*) filter (where ${attendanceRecords.status} = 'absent')::int`,
          todayStatus: sql<string | null>`max(${attendanceRecords.status}) filter (where ${attendanceRecords.date} = ${today})`,
        })
        .from(attendanceRecords)
        .where(and(eq(attendanceRecords.studentId, sid), gte(attendanceRecords.date, year.startDate), lte(attendanceRecords.date, year.endDate)));
      child.attendance = a;
    }
    if (has(ctx, 'fees')) {
      const [f] = await ctx.db
        .select({ balance: sql<number>`coalesce(sum(${BALANCE}),0)::float`, overdue: sql<number>`coalesce(sum(${BALANCE}) filter (where ${feeInvoices.dueDate} < ${today}),0)::float`, nextDue: sql<string | null>`min(${feeInvoices.dueDate}) filter (where ${feeInvoices.dueDate} >= ${today})` })
        .from(feeInvoices)
        .where(and(eq(feeInvoices.studentId, sid), inArray(feeInvoices.status, ['unpaid', 'partial'])));
      child.fees = f;
    }
    if (has(ctx, 'exams')) {
      const [latest] = await ctx.db
        .select({ id: exams.id, name: exams.name })
        .from(exams)
        .innerJoin(examPapers, eq(examPapers.examId, exams.id))
        .innerJoin(enrollments, and(eq(enrollments.studentId, sid), eq(enrollments.academicYearId, exams.academicYearId)))
        .innerJoin(sections, and(eq(sections.id, enrollments.sectionId), eq(sections.classId, examPapers.classId)))
        .where(and(eq(exams.schoolId, ctx.schoolId), eq(exams.status, 'published')))
        .orderBy(desc(exams.approvedAt))
        .limit(1);
      if (latest) {
        const { results } = await computeResults(ctx, latest.id, { studentIds: [sid] });
        const r = results[0];
        child.latestResult = r ? { examId: latest.id, examName: latest.name, percentage: r.percentage, grade: r.grade, rank: r.rank, passed: r.passed, subjects: r.subjects.map((x) => ({ name: x.subjectName, marks: x.marks, max: x.maxMarks })) } : null;
      }
    }
    if (has(ctx, 'homework') && s?.sectionId) {
      child.homework = await ctx.db
        .select({
          id: assignments.id,
          title: assignments.title,
          dueDate: assignments.dueDate,
          subject: sql<string | null>`(select name from subjects where id = ${assignments.subjectId})`,
          status: sql<string>`coalesce((select status from ${submissions} where ${submissions.assignmentId} = ${assignments.id} and ${submissions.studentId} = ${sid}), 'pending')`,
        })
        .from(assignments)
        .where(and(eq(assignments.sectionId, s.sectionId), gte(assignments.dueDate, daysFrom(-7))))
        .orderBy(asc(assignments.dueDate))
        .limit(6);
    }
    children.push(child);
  }
  const out: Record<string, unknown> = { kind: ctx.roleKey === 'student' ? 'student' : 'parent', children };
  if (has(ctx, 'communication')) out.announcements = (await listAnnouncements(ctx, { page: 1, pageSize: 5 })).rows;
  if (has(ctx, 'events')) out.upcomingEvents = (await listEvents(ctx, today, daysFrom(45))).slice(0, 6);
  if (has(ctx, 'meetings') && ctx.roleKey === 'parent') out.meetings = await upcomingMeetings(ctx, eq(meetings.parentUserId, ctx.userId));
  if (has(ctx, 'timetable') && ctx.roleKey === 'student' && children[0]?.sectionId) {
    const dow = new Date().getDay() || 7;
    out.today = await ctx.db.execute(sql`
      select p.name as period, p.start_time as "startTime", p.end_time as "endTime", p.is_break as "isBreak", s.name as subject, u.full_name as teacher
      from periods p left join timetable_entries t on t.period_id = p.id and t.section_id = ${children[0].sectionId as string} and t.day_of_week = ${dow}
      left join subjects s on s.id = t.subject_id left join users u on u.id = t.teacher_id
      where p.school_id = ${ctx.schoolId} order by p.sort_order`);
  }
  return out;
}

export async function accountantDashboard(ctx: Ctx) {
  const today = iso(new Date());
  const monthStart = today.slice(0, 8) + '01';
  const yearId = await currentYearId(ctx);
  const [year] = yearId ? await ctx.db.select().from(academicYears).where(eq(academicYears.id, yearId)) : [];
  const sumSince = (from: string) =>
    ctx.db
      .select({ amount: sql<number>`coalesce(sum(${payments.amount}),0)::float`, n: sql<number>`count(*)::int` })
      .from(payments)
      .where(and(eq(payments.schoolId, ctx.schoolId), eq(payments.status, 'completed'), gte(payments.paidAt, new Date(from))));
  const [[t], [m], [y], [dues]] = await Promise.all([
    sumSince(today),
    sumSince(monthStart),
    sumSince(year?.startDate ?? monthStart),
    ctx.db
      .select({
        outstanding: sql<number>`coalesce(sum(${BALANCE}),0)::float`,
        overdue: sql<number>`coalesce(sum(${BALANCE}) filter (where ${feeInvoices.dueDate} < ${today}),0)::float`,
        defaulters: sql<number>`count(distinct ${feeInvoices.studentId}) filter (where ${feeInvoices.dueDate} < ${today})::int`,
      })
      .from(feeInvoices)
      .where(and(eq(feeInvoices.schoolId, ctx.schoolId), inArray(feeInvoices.status, ['unpaid', 'partial']))),
  ]);
  const recent = await ctx.db
    .select({ id: payments.id, receiptNo: payments.receiptNo, amount: payments.amount, method: payments.method, paidAt: payments.paidAt, studentName: sql<string>`${students.firstName} || ' ' || ${students.lastName}` })
    .from(payments)
    .innerJoin(students, eq(students.id, payments.studentId))
    .where(and(eq(payments.schoolId, ctx.schoolId), eq(payments.status, 'completed')))
    .orderBy(desc(payments.paidAt))
    .limit(8);
  const defaulters = await ctx.db
    .select({ studentId: feeInvoices.studentId, name: sql<string>`max(${students.firstName} || ' ' || ${students.lastName})`, admissionNo: sql<string>`max(${students.admissionNo})`, balance: sql<number>`sum(${BALANCE})::float` })
    .from(feeInvoices)
    .innerJoin(students, eq(students.id, feeInvoices.studentId))
    .where(and(eq(feeInvoices.schoolId, ctx.schoolId), inArray(feeInvoices.status, ['unpaid', 'partial']), sql`${feeInvoices.dueDate} < ${today}`))
    .groupBy(feeInvoices.studentId)
    .orderBy(desc(sql`sum(${BALANCE})`))
    .limit(8);
  const byMethod = await ctx.db
    .select({ method: payments.method, amount: sql<number>`sum(${payments.amount})::float` })
    .from(payments)
    .where(and(eq(payments.schoolId, ctx.schoolId), eq(payments.status, 'completed'), gte(payments.paidAt, new Date(monthStart))))
    .groupBy(payments.method);
  return {
    kind: 'accountant',
    collections: { today: t.amount, todayCount: t.n, month: m.amount, year: y.amount },
    dues,
    recentPayments: recent,
    defaulters,
    byMethod,
    trend: await feeTrend(ctx, 12),
  };
}

export async function dashboardFor(ctx: Ctx) {
  if (ctx.roleKey === 'accountant') return accountantDashboard(ctx);
  if (ctx.scope === 'own') return familyDashboard(ctx);
  if (ctx.scope === 'assigned') return teacherDashboard(ctx);
  return adminDashboard(ctx);
}
