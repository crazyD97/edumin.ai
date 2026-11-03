/** Student business logic. Routes and (later) MCP tools call these. */
import { z } from 'zod';
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { GENDERS, STUDENT_STATUSES } from '@edumin/shared';
import { academicYears, classes, enrollments, guardians, roles, schools, sections, studentGuardians, students, users } from '../../db/schema';
import { assertStudentAccess, requirePermission, scopedStudentIds, withTx, type Ctx } from '../../core/context';
import { badRequest, conflict, must } from '../../core/errors';
import { nextNumber } from '../../core/sequence';
import { hashPassword } from '../../core/auth';
import { audit } from '../../core/audit';
import { optDate, optStr, optUuid } from '../../core/http';
import { getSection, resolveYearId } from '../academics/routes';

export const guardianInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(2).max(200),
  relation: z.string().trim().max(30).default('guardian'),
  phone: optStr,
  email: z.email().nullish().or(z.literal('').transform(() => null)),
  occupation: optStr,
  address: optStr,
  isPrimary: z.boolean().default(false),
});

export const studentInput = z.object({
  admissionNo: optStr, // generated when blank
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).default(''),
  dateOfBirth: optDate,
  gender: z.enum(GENDERS).nullish().or(z.literal('').transform(() => null)),
  bloodGroup: optStr,
  photoUrl: optStr,
  email: z.email().nullish().or(z.literal('').transform(() => null)),
  phone: optStr,
  address: optStr,
  nationality: optStr,
  religion: optStr,
  previousSchool: optStr,
  medicalNotes: optStr,
  admissionDate: optDate,
  sectionId: optUuid,
  rollNo: z.coerce.number().int().positive().nullish(),
  guardians: z.array(guardianInput).default([]),
});
export type StudentInput = z.infer<typeof studentInput>;

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
  search: z.string().trim().optional(),
  status: z.enum(STUDENT_STATUSES).optional(),
  classId: z.uuid().optional(),
  sectionId: z.uuid().optional(),
  academicYearId: z.uuid().optional(),
  gender: z.enum(GENDERS).optional(),
});

/** Student search with current-year class/section. Respects the caller's scope. */
export async function listStudents(ctx: Ctx, q: z.infer<typeof listQuery>) {
  requirePermission(ctx, 'students.view');
  const yearId = await resolveYearId(ctx, q.academicYearId);
  const scoped = await scopedStudentIds(ctx);
  if (scoped && !scoped.length) return { rows: [], total: 0 };
  const where: (SQL | undefined)[] = [
    eq(students.schoolId, ctx.schoolId),
    scoped ? inArray(students.id, scoped) : undefined,
    q.status ? eq(students.status, q.status) : undefined,
    q.gender ? eq(students.gender, q.gender) : undefined,
    q.classId ? eq(sections.classId, q.classId) : undefined,
    q.sectionId ? eq(enrollments.sectionId, q.sectionId) : undefined,
    q.search
      ? or(
          ilike(sql`${students.firstName} || ' ' || ${students.lastName}`, `%${q.search}%`),
          ilike(students.admissionNo, `%${q.search}%`),
          ilike(students.phone, `%${q.search}%`),
        )
      : undefined,
  ];
  const base = ctx.db
    .select({
      id: students.id,
      admissionNo: students.admissionNo,
      firstName: students.firstName,
      lastName: students.lastName,
      gender: students.gender,
      dateOfBirth: students.dateOfBirth,
      phone: students.phone,
      email: students.email,
      photoUrl: students.photoUrl,
      status: students.status,
      admissionDate: students.admissionDate,
      sectionId: sections.id,
      sectionName: sections.name,
      classId: classes.id,
      className: classes.name,
      rollNo: enrollments.rollNo,
      hasLogin: sql<boolean>`${students.userId} is not null`,
    })
    .from(students)
    .leftJoin(enrollments, and(eq(enrollments.studentId, students.id), eq(enrollments.academicYearId, yearId)))
    .leftJoin(sections, eq(sections.id, enrollments.sectionId))
    .leftJoin(classes, eq(classes.id, sections.classId))
    .where(and(...where));
  const rows = await base
    .orderBy(asc(classes.level), asc(sections.name), asc(enrollments.rollNo), asc(students.firstName))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [{ n }] = await ctx.db
    .select({ n: count() })
    .from(students)
    .leftJoin(enrollments, and(eq(enrollments.studentId, students.id), eq(enrollments.academicYearId, yearId)))
    .leftJoin(sections, eq(sections.id, enrollments.sectionId))
    .where(and(...where));
  return { rows, total: n };
}

export async function getStudent(ctx: Ctx, id: string) {
  requirePermission(ctx, 'students.view');
  await assertStudentAccess(ctx, id);
  const [s] = await ctx.db.select().from(students).where(and(eq(students.id, id), eq(students.schoolId, ctx.schoolId)));
  must(s, 'Student');
  const g = await ctx.db
    .select({
      id: guardians.id,
      name: guardians.name,
      relation: guardians.relation,
      phone: guardians.phone,
      email: guardians.email,
      occupation: guardians.occupation,
      address: guardians.address,
      isPrimary: studentGuardians.isPrimary,
      hasLogin: sql<boolean>`${guardians.userId} is not null`,
    })
    .from(studentGuardians)
    .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .where(eq(studentGuardians.studentId, id));
  const history = await ctx.db
    .select({
      id: enrollments.id,
      academicYearId: academicYears.id,
      academicYear: academicYears.name,
      isCurrentYear: academicYears.isCurrent,
      sectionId: sections.id,
      className: classes.name,
      sectionName: sections.name,
      rollNo: enrollments.rollNo,
      status: enrollments.status,
    })
    .from(enrollments)
    .innerJoin(academicYears, eq(academicYears.id, enrollments.academicYearId))
    .innerJoin(sections, eq(sections.id, enrollments.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(eq(enrollments.studentId, id))
    .orderBy(desc(academicYears.startDate));
  const { userId, ...rest } = s;
  return { ...rest, hasLogin: !!userId, guardians: g, history, current: history.find((h) => h.isCurrentYear) ?? null };
}

async function upsertGuardians(ctx: Ctx, studentId: string, list: z.infer<typeof guardianInput>[]) {
  await ctx.db.delete(studentGuardians).where(eq(studentGuardians.studentId, studentId));
  let hasPrimary = list.some((g) => g.isPrimary);
  for (const g of list) {
    let gid = g.id;
    const data = { name: g.name, relation: g.relation, phone: g.phone, email: g.email?.toLowerCase() ?? null, occupation: g.occupation, address: g.address };
    if (gid) {
      const [row] = await ctx.db.update(guardians).set(data).where(and(eq(guardians.id, gid), eq(guardians.schoolId, ctx.schoolId))).returning();
      must(row, 'Guardian');
    } else {
      // Siblings share guardians: reuse an existing guardian with the same email or phone.
      const match = data.email ? eq(guardians.email, data.email) : data.phone ? eq(guardians.phone, data.phone) : undefined;
      const [existing] = match ? await ctx.db.select().from(guardians).where(and(eq(guardians.schoolId, ctx.schoolId), match, ilike(guardians.name, data.name))) : [];
      if (existing) {
        gid = existing.id;
        await ctx.db.update(guardians).set(data).where(eq(guardians.id, gid));
      } else {
        [{ id: gid }] = await ctx.db.insert(guardians).values({ ...data, schoolId: ctx.schoolId }).returning({ id: guardians.id });
      }
    }
    await ctx.db
      .insert(studentGuardians)
      .values({ studentId, guardianId: gid!, isPrimary: g.isPrimary || !hasPrimary })
      .onConflictDoNothing();
    hasPrimary = true;
  }
}

async function nextRollNo(ctx: Ctx, sectionId: string) {
  const [{ max }] = await ctx.db.select({ max: sql<number>`coalesce(max(${enrollments.rollNo}),0)::int` }).from(enrollments).where(eq(enrollments.sectionId, sectionId));
  return max + 1;
}

export async function enroll(ctx: Ctx, studentId: string, sectionId: string, rollNo?: number | null) {
  const sec = await getSection(ctx, sectionId);
  const existing = await ctx.db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.studentId, studentId), eq(enrollments.academicYearId, sec.academicYearId)));
  const roll = rollNo ?? (existing[0]?.sectionId === sectionId ? existing[0].rollNo : await nextRollNo(ctx, sectionId));
  if (existing[0]) {
    await ctx.db.update(enrollments).set({ sectionId, rollNo: roll, status: 'active' }).where(eq(enrollments.id, existing[0].id));
  } else {
    await ctx.db.insert(enrollments).values({ schoolId: ctx.schoolId, studentId, academicYearId: sec.academicYearId, sectionId, rollNo: roll });
  }
}

export async function createStudent(ctx: Ctx, input: StudentInput, opts: { audit?: boolean } = {}) {
  requirePermission(ctx, 'students.create');
  const [school] = await ctx.db.select({ settings: schools.settings }).from(schools).where(eq(schools.id, ctx.schoolId));
  return ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    const admissionNo = input.admissionNo || (await nextNumber(tx, ctx.schoolId, 'admission', school.settings.admissionNoFormat));
    const [dupe] = await tx.select({ id: students.id }).from(students).where(and(eq(students.schoolId, ctx.schoolId), eq(students.admissionNo, admissionNo)));
    if (dupe) throw conflict(`Admission number ${admissionNo} is already in use`);
    const { guardians: gList, sectionId, rollNo, ...data } = input;
    const [s] = await tx
      .insert(students)
      .values({ ...data, email: data.email?.toLowerCase() ?? null, admissionNo, schoolId: ctx.schoolId, admissionDate: data.admissionDate ?? new Date().toISOString().slice(0, 10) })
      .returning();
    await upsertGuardians(t, s.id, gList);
    if (sectionId) await enroll(t, s.id, sectionId, rollNo);
    if (opts.audit !== false) await audit(t, 'create', 'student', s.id, { admissionNo });
    return s;
  });
}

export async function updateStudent(ctx: Ctx, id: string, input: StudentInput) {
  requirePermission(ctx, 'students.edit');
  await assertStudentAccess(ctx, id);
  return ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    const { guardians: gList, sectionId, rollNo, admissionNo, ...data } = input;
    const [s] = await tx
      .update(students)
      .set({ ...data, email: data.email?.toLowerCase() ?? null, ...(admissionNo ? { admissionNo } : {}) })
      .where(and(eq(students.id, id), eq(students.schoolId, ctx.schoolId)))
      .returning();
    must(s, 'Student');
    await upsertGuardians(t, id, gList);
    if (sectionId) await enroll(t, id, sectionId, rollNo);
    await audit(t, 'update', 'student', id);
    return s;
  });
}

/** Transfer out, withdraw, deactivate or reactivate a student. History is kept. */
export async function changeStatus(ctx: Ctx, id: string, body: { status: (typeof STUDENT_STATUSES)[number]; date?: string | null; reason?: string | null }) {
  requirePermission(ctx, 'students.edit');
  const [s] = await ctx.db.select().from(students).where(and(eq(students.id, id), eq(students.schoolId, ctx.schoolId)));
  must(s, 'Student');
  const leaving = ['transferred', 'withdrawn', 'graduated'].includes(body.status);
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(students)
      .set({ status: body.status, exitDate: leaving ? (body.date ?? new Date().toISOString().slice(0, 10)) : null, exitReason: leaving ? (body.reason ?? null) : null })
      .where(eq(students.id, id));
    const yearRows = await tx.select({ id: academicYears.id }).from(academicYears).where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)));
    if (yearRows[0]) {
      const enrollStatus = body.status === 'transferred' ? 'transferred' : body.status === 'withdrawn' ? 'withdrawn' : body.status === 'graduated' ? 'completed' : 'active';
      await tx.update(enrollments).set({ status: enrollStatus }).where(and(eq(enrollments.studentId, id), eq(enrollments.academicYearId, yearRows[0].id)));
    }
    if (leaving && s.userId) await tx.update(users).set({ isActive: false }).where(eq(users.id, s.userId));
    if (body.status === 'active' && s.userId) await tx.update(users).set({ isActive: true }).where(eq(users.id, s.userId));
  });
  await audit(ctx, 'status_' + body.status, 'student', id, body);
}

export const promoteInput = z.object({
  fromSectionId: z.uuid(),
  toAcademicYearId: z.uuid(),
  items: z
    .array(
      z.object({
        studentId: z.uuid(),
        action: z.enum(['promote', 'retain', 'graduate', 'leave']),
        toSectionId: z.uuid().nullish(),
      }),
    )
    .min(1),
});

/**
 * Year-end promotion. The old enrollment is closed (promoted/retained/completed)
 * and a new one is opened in the target year, preserving the full history.
 */
export async function promote(ctx: Ctx, input: z.infer<typeof promoteInput>) {
  requirePermission(ctx, 'students.edit');
  const from = await getSection(ctx, input.fromSectionId);
  const toYear = await resolveYearId(ctx, input.toAcademicYearId);
  if (toYear === from.academicYearId) throw badRequest('Target year must differ from the source year');
  const summary = { promoted: 0, retained: 0, graduated: 0, left: 0 };
  await ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    for (const it of input.items) {
      const [e] = await tx
        .select()
        .from(enrollments)
        .where(and(eq(enrollments.studentId, it.studentId), eq(enrollments.sectionId, from.id)));
      if (!e) throw badRequest('A student in the list is not enrolled in the source section');
      if (it.action === 'promote' || it.action === 'retain') {
        if (!it.toSectionId) throw badRequest('Choose a target section for every promoted or retained student');
        const to = await getSection(t, it.toSectionId);
        if (to.academicYearId !== toYear) throw badRequest('Target section belongs to a different academic year');
        await tx.update(enrollments).set({ status: it.action === 'promote' ? 'promoted' : 'retained' }).where(eq(enrollments.id, e.id));
        await enroll(t, it.studentId, to.id);
        it.action === 'promote' ? summary.promoted++ : summary.retained++;
      } else {
        await tx.update(enrollments).set({ status: it.action === 'graduate' ? 'completed' : 'withdrawn' }).where(eq(enrollments.id, e.id));
        await tx
          .update(students)
          .set({ status: it.action === 'graduate' ? 'graduated' : 'withdrawn', exitDate: new Date().toISOString().slice(0, 10) })
          .where(eq(students.id, it.studentId));
        it.action === 'graduate' ? summary.graduated++ : summary.left++;
      }
    }
  });
  await audit(ctx, 'promote', 'section', from.id, summary);
  return summary;
}

/** Creates (or resets) a portal login for a student or guardian. */
export async function createPortalAccount(ctx: Ctx, kind: 'student' | 'parent', recordId: string, email: string, password: string) {
  requirePermission(ctx, 'students.edit');
  const [role] = await ctx.db.select().from(roles).where(and(eq(roles.schoolId, ctx.schoolId), eq(roles.key, kind)));
  must(role, 'Role');
  const table = kind === 'student' ? students : guardians;
  const nameOf = (r: any) => (kind === 'student' ? `${r.firstName} ${r.lastName}`.trim() : r.name);
  const [rec] = await ctx.db.select().from(table).where(and(eq(table.id, recordId), eq(table.schoolId, ctx.schoolId)));
  must(rec, kind === 'student' ? 'Student' : 'Guardian');
  const hash = await hashPassword(password);
  const lower = email.toLowerCase();
  return ctx.db.transaction(async (tx) => {
    if (rec.userId) {
      await tx.update(users).set({ email: lower, passwordHash: hash, isActive: true, tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, rec.userId));
      return { userId: rec.userId, created: false };
    }
    const [taken] = await tx.select({ id: users.id }).from(users).where(and(eq(users.schoolId, ctx.schoolId), eq(users.email, lower)));
    if (taken) throw conflict('Another account already uses this email');
    const [u] = await tx.insert(users).values({ schoolId: ctx.schoolId, roleId: role.id, email: lower, fullName: nameOf(rec), phone: rec.phone, passwordHash: hash }).returning();
    await tx.update(table).set({ userId: u.id }).where(eq(table.id, recordId));
    return { userId: u.id, created: true };
  });
}

// ── Bulk import ──

export const IMPORT_COLUMNS = [
  'admissionNo',
  'firstName',
  'lastName',
  'gender',
  'dateOfBirth',
  'phone',
  'email',
  'address',
  'class',
  'section',
  'rollNo',
  'guardianName',
  'guardianRelation',
  'guardianPhone',
  'guardianEmail',
] as const;

export async function importStudents(ctx: Ctx, rows: Record<string, string>[], dryRun: boolean) {
  requirePermission(ctx, 'students.create');
  const yearId = await resolveYearId(ctx, null);
  const secs = await ctx.db
    .select({ id: sections.id, name: sections.name, className: classes.name })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(and(eq(sections.schoolId, ctx.schoolId), eq(sections.academicYearId, yearId)));
  const secKey = (c: string, s: string) => `${c.trim().toLowerCase()}|${s.trim().toLowerCase()}`;
  const secMap = new Map(secs.map((s) => [secKey(s.className, s.name), s.id]));
  const errors: { row: number; message: string }[] = [];
  const parsed: StudentInput[] = [];
  rows.forEach((raw, i) => {
    const rowNo = i + 2; // header is row 1
    let sectionId: string | null = null;
    if (raw.class || raw.section) {
      sectionId = secMap.get(secKey(raw.class ?? '', raw.section ?? '')) ?? null;
      if (!sectionId) errors.push({ row: rowNo, message: `Class "${raw.class}" section "${raw.section}" not found in the current year` });
    }
    const g = raw.guardianName ? [{ name: raw.guardianName, relation: raw.guardianRelation || 'guardian', phone: raw.guardianPhone, email: raw.guardianEmail, isPrimary: true }] : [];
    const res = studentInput.safeParse({
      admissionNo: raw.admissionNo,
      firstName: raw.firstName,
      lastName: raw.lastName ?? '',
      gender: raw.gender?.toLowerCase() || '',
      dateOfBirth: normaliseDate(raw.dateOfBirth),
      phone: raw.phone,
      email: raw.email,
      address: raw.address,
      sectionId,
      rollNo: raw.rollNo || null,
      guardians: g,
    });
    if (!res.success) errors.push({ row: rowNo, message: res.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
    else parsed.push(res.data);
  });
  const nos = parsed.map((p) => p.admissionNo).filter(Boolean) as string[];
  if (new Set(nos).size !== nos.length) errors.push({ row: 0, message: 'Duplicate admission numbers in file' });
  if (nos.length) {
    const taken = await ctx.db.select({ no: students.admissionNo }).from(students).where(and(eq(students.schoolId, ctx.schoolId), inArray(students.admissionNo, nos)));
    for (const t of taken) errors.push({ row: 0, message: `Admission number ${t.no} already exists` });
  }
  if (errors.length || dryRun) return { valid: parsed.length, imported: 0, errors };
  let imported = 0;
  for (const p of parsed) {
    await createStudent(ctx, p, { audit: false });
    imported++;
  }
  await audit(ctx, 'import', 'student', null, { imported });
  return { valid: parsed.length, imported, errors };
}

function normaliseDate(v?: string) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // DD/MM/YYYY
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(+d) ? s : d.toISOString().slice(0, 10);
}
