/** Homework: teachers assign to a section, students submit, teachers grade. */
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { assignments, classes, enrollments, files, sections, students, subjects, submissions, users } from '../../db/schema';
import { assertCanTeachSection, assertStudentAccess, ownStudentIds, requirePermission, scopedSectionIds, type Ctx } from '../../core/context';
import { badRequest, forbidden, must } from '../../core/errors';
import { audience, notifyUsers } from '../../core/notify';
import { getSection } from '../academics/routes';

export const assignmentInput = z.object({
  sectionId: z.uuid(),
  subjectId: z.uuid().nullish(),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(10000).nullish(),
  dueDate: z.iso.date(),
  maxMarks: z.coerce.number().positive().nullish(),
});

export const listQuery = z.object({
  sectionId: z.uuid().optional(),
  subjectId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z.enum(['upcoming', 'past']).optional(),
});

export async function listAssignments(ctx: Ctx, q: z.infer<typeof listQuery>) {
  requirePermission(ctx, 'homework.view');
  const scoped = await scopedSectionIds(ctx);
  if (scoped && !scoped.length) return [];
  const today = new Date().toISOString().slice(0, 10);
  const own = ctx.scope === 'own' ? await ownStudentIds(ctx) : [];
  const rows = await ctx.db
    .select({
      a: assignments,
      subjectName: subjects.name,
      teacherName: users.fullName,
      sectionLabel: sql<string>`${classes.name} || ' - ' || ${sections.name}`,
      submitted: sql<number>`(select count(*)::int from ${submissions} where ${submissions.assignmentId} = ${assignments.id})`,
      graded: sql<number>`(select count(*)::int from ${submissions} where ${submissions.assignmentId} = ${assignments.id} and ${submissions.status} = 'graded')`,
      enrolled: sql<number>`(select count(*)::int from ${enrollments} where ${enrollments.sectionId} = ${assignments.sectionId} and ${enrollments.status} = 'active')`,
      attachments: sql<number>`(select count(*)::int from ${files} where ${files.entity} = 'assignment' and ${files.entityId} = ${assignments.id})`,
    })
    .from(assignments)
    .innerJoin(sections, eq(sections.id, assignments.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(subjects, eq(subjects.id, assignments.subjectId))
    .leftJoin(users, eq(users.id, assignments.teacherId))
    .where(
      and(
        eq(assignments.schoolId, ctx.schoolId),
        scoped ? inArray(assignments.sectionId, scoped) : undefined,
        q.sectionId ? eq(assignments.sectionId, q.sectionId) : undefined,
        q.subjectId ? eq(assignments.subjectId, q.subjectId) : undefined,
        q.from ? gte(assignments.dueDate, q.from) : undefined,
        q.to ? lte(assignments.dueDate, q.to) : undefined,
        q.status === 'upcoming' ? gte(assignments.dueDate, today) : q.status === 'past' ? sql`${assignments.dueDate} < ${today}` : undefined,
      ),
    )
    .orderBy(desc(assignments.dueDate))
    .limit(300);
  // For students/parents, attach each child's submission status.
  let mine = new Map<string, typeof submissions.$inferSelect>();
  if (own.length && rows.length) {
    const subs = await ctx.db.select().from(submissions).where(and(inArray(submissions.studentId, own), inArray(submissions.assignmentId, rows.map((r) => r.a.id))));
    mine = new Map(subs.map((s) => [s.assignmentId, s]));
  }
  return rows.map((r) => ({
    ...r.a,
    subjectName: r.subjectName,
    teacherName: r.teacherName,
    sectionLabel: r.sectionLabel,
    submitted: r.submitted,
    graded: r.graded,
    enrolled: r.enrolled,
    attachments: r.attachments,
    mySubmission: mine.get(r.a.id) ?? null,
    myStatus: own.length ? (mine.get(r.a.id)?.status ?? (r.a.dueDate < today ? 'missing' : 'pending')) : undefined,
  }));
}

async function getAssignment(ctx: Ctx, id: string) {
  const [a] = await ctx.db.select().from(assignments).where(and(eq(assignments.id, id), eq(assignments.schoolId, ctx.schoolId)));
  const row = must(a, 'Assignment');
  const scoped = await scopedSectionIds(ctx);
  if (scoped && !scoped.includes(row.sectionId)) throw forbidden();
  return row;
}

export async function createAssignment(ctx: Ctx, v: z.infer<typeof assignmentInput>) {
  requirePermission(ctx, 'homework.create');
  await assertCanTeachSection(ctx, v.sectionId);
  const sec = await getSection(ctx, v.sectionId);
  if (v.subjectId) must((await ctx.db.select({ id: subjects.id }).from(subjects).where(and(eq(subjects.id, v.subjectId), eq(subjects.schoolId, ctx.schoolId))))[0], 'Subject');
  const [row] = await ctx.db.insert(assignments).values({ ...v, schoolId: ctx.schoolId, teacherId: ctx.userId }).returning();
  const studs = (await ctx.db.select({ id: enrollments.studentId }).from(enrollments).where(and(eq(enrollments.sectionId, sec.id), eq(enrollments.status, 'active')))).map((r) => r.id);
  await notifyUsers(ctx.db, ctx.schoolId, await audience.forStudents(ctx.db, ctx.schoolId, studs), {
    type: 'homework',
    title: `New homework: ${v.title}`,
    body: `Due ${v.dueDate}`,
    link: `/homework/${row.id}`,
  });
  return row;
}

export async function updateAssignment(ctx: Ctx, id: string, v: z.infer<typeof assignmentInput>) {
  requirePermission(ctx, 'homework.edit');
  const a = await getAssignment(ctx, id);
  await assertCanTeachSection(ctx, a.sectionId);
  if (v.sectionId !== a.sectionId) await assertCanTeachSection(ctx, v.sectionId);
  const [row] = await ctx.db.update(assignments).set(v).where(eq(assignments.id, id)).returning();
  return row;
}

export async function deleteAssignment(ctx: Ctx, id: string) {
  requirePermission(ctx, 'homework.delete');
  const a = await getAssignment(ctx, id);
  await assertCanTeachSection(ctx, a.sectionId);
  await ctx.db.delete(assignments).where(eq(assignments.id, id));
}

/** Assignment with the full submission roster (staff) or just own submissions (student/parent). */
export async function assignmentDetail(ctx: Ctx, id: string) {
  requirePermission(ctx, 'homework.view');
  const a = await getAssignment(ctx, id);
  const [meta] = await ctx.db
    .select({ subjectName: subjects.name, teacherName: users.fullName, sectionLabel: sql<string>`${classes.name} || ' - ' || ${sections.name}` })
    .from(assignments)
    .innerJoin(sections, eq(sections.id, assignments.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(subjects, eq(subjects.id, assignments.subjectId))
    .leftJoin(users, eq(users.id, assignments.teacherId))
    .where(eq(assignments.id, id));
  const own = ctx.scope === 'own' ? await ownStudentIds(ctx) : null;
  const today = new Date().toISOString().slice(0, 10);
  const roster = await ctx.db
    .select({
      studentId: students.id,
      name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
      admissionNo: students.admissionNo,
      rollNo: enrollments.rollNo,
      submission: submissions,
      fileCount: sql<number>`(select count(*)::int from ${files} where ${files.entity} = 'submission' and ${files.entityId} = ${submissions.id})`,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .leftJoin(submissions, and(eq(submissions.studentId, students.id), eq(submissions.assignmentId, id)))
    .where(and(eq(enrollments.sectionId, a.sectionId), eq(enrollments.status, 'active'), own ? inArray(students.id, own.length ? own : ['00000000-0000-0000-0000-000000000000']) : undefined))
    .orderBy(asc(enrollments.rollNo));
  return {
    ...a,
    ...meta,
    canManage: ctx.scope !== 'own' && ctx.permissions.has('homework.edit'),
    submissions: roster.map((r) => ({
      studentId: r.studentId,
      name: r.name,
      admissionNo: r.admissionNo,
      rollNo: r.rollNo,
      fileCount: r.submission ? r.fileCount : 0,
      ...(r.submission ?? {}),
      id: r.submission?.id ?? null,
      status: r.submission?.status ?? (a.dueDate < today ? 'missing' : 'pending'),
    })),
  };
}

export const submitInput = z.object({ studentId: z.uuid().optional(), content: z.string().trim().max(20000).nullish() });

/** Students submit their own work; parents may submit on behalf of their child. */
export async function submit(ctx: Ctx, assignmentId: string, v: z.infer<typeof submitInput>) {
  if (ctx.scope !== 'own') throw forbidden('Only students or parents can submit homework');
  const a = await getAssignment(ctx, assignmentId);
  const own = await ownStudentIds(ctx);
  const studentId = v.studentId ?? (own.length === 1 ? own[0] : null);
  if (!studentId || !own.includes(studentId)) throw badRequest('Choose the student');
  const [enrolled] = await ctx.db.select().from(enrollments).where(and(eq(enrollments.studentId, studentId), eq(enrollments.sectionId, a.sectionId)));
  if (!enrolled) throw forbidden();
  const [existing] = await ctx.db.select().from(submissions).where(and(eq(submissions.assignmentId, assignmentId), eq(submissions.studentId, studentId)));
  if (existing?.status === 'graded') throw badRequest('This submission has already been graded');
  const status = new Date().toISOString().slice(0, 10) > a.dueDate ? 'late' : 'submitted';
  const [row] = await ctx.db
    .insert(submissions)
    .values({ schoolId: ctx.schoolId, assignmentId, studentId, content: v.content ?? null, status, submittedAt: new Date() })
    .onConflictDoUpdate({ target: [submissions.assignmentId, submissions.studentId], set: { content: v.content ?? null, status, submittedAt: new Date() } })
    .returning();
  if (a.teacherId) await notifyUsers(ctx.db, ctx.schoolId, [a.teacherId], { type: 'homework_submission', title: `New submission: ${a.title}`, link: `/homework/${a.id}` });
  return row;
}

export const gradeInput = z.object({ studentId: z.uuid(), marks: z.coerce.number().min(0).nullish(), feedback: z.string().trim().max(5000).nullish() });

export async function grade(ctx: Ctx, assignmentId: string, v: z.infer<typeof gradeInput>) {
  requirePermission(ctx, 'homework.edit');
  const a = await getAssignment(ctx, assignmentId);
  await assertCanTeachSection(ctx, a.sectionId);
  await assertStudentAccess(ctx, v.studentId);
  if (a.maxMarks && v.marks != null && v.marks > a.maxMarks) throw badRequest(`Marks cannot exceed ${a.maxMarks}`);
  const [row] = await ctx.db
    .insert(submissions)
    .values({ schoolId: ctx.schoolId, assignmentId, studentId: v.studentId, status: 'graded', marks: v.marks ?? null, feedback: v.feedback ?? null, gradedBy: ctx.userId, gradedAt: new Date() })
    .onConflictDoUpdate({
      target: [submissions.assignmentId, submissions.studentId],
      set: { status: 'graded', marks: v.marks ?? null, feedback: v.feedback ?? null, gradedBy: ctx.userId, gradedAt: new Date() },
    })
    .returning();
  await notifyUsers(ctx.db, ctx.schoolId, await audience.forStudents(ctx.db, ctx.schoolId, [v.studentId]), {
    type: 'homework_graded',
    title: `Homework reviewed: ${a.title}`,
    body: v.feedback ?? undefined,
    link: `/homework/${a.id}`,
  });
  return row;
}
