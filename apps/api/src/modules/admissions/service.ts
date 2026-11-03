/** Admissions pipeline: enquiry → application → review → enrolled student. */
import { z } from 'zod';
import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { APPLICATION_STATUSES, ENQUIRY_STATUSES, GENDERS } from '@edumin/shared';
import { academicYears, admissionApplications, admissionEnquiries, classes, schools, sections } from '../../db/schema';
import type { Executor } from '../../core/db';
import { requirePermission, type Ctx } from '../../core/context';
import { badRequest, must } from '../../core/errors';
import { nextNumber } from '../../core/sequence';
import { audit } from '../../core/audit';
import { audience, notifyUsers } from '../../core/notify';
import { createStudent } from '../students/service';

const opt = z.string().trim().max(500).nullish();

export const enquiryInput = z.object({
  studentName: z.string().trim().min(2).max(200),
  guardianName: z.string().trim().min(2).max(200),
  phone: z.string().trim().min(5).max(30),
  email: z.email().nullish().or(z.literal('').transform(() => null)),
  classId: z.uuid().nullish().or(z.literal('').transform(() => null)),
  message: z.string().trim().max(2000).nullish(),
});

export const applicationInput = z.object({
  classId: z.uuid(),
  enquiryId: z.uuid().nullish(),
  student: z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().max(100).default(''),
    dateOfBirth: z.iso.date().nullish().or(z.literal('').transform(() => null)),
    gender: z.enum(GENDERS).nullish().or(z.literal('').transform(() => null)),
    previousSchool: opt,
    address: opt,
  }),
  guardian: z.object({
    name: z.string().trim().min(2).max(200),
    relation: z.string().trim().max(30).default('guardian'),
    phone: z.string().trim().min(5).max(30),
    email: z.email().nullish().or(z.literal('').transform(() => null)),
    occupation: opt,
  }),
});

async function schoolAdmins(db: Executor, schoolId: string) {
  return audience.byRoleKeys(db, schoolId, ['school_admin', 'principal']);
}

async function assertClass(db: Executor, schoolId: string, classId: string | null | undefined) {
  if (!classId) return;
  const [c] = await db.select({ id: classes.id }).from(classes).where(and(eq(classes.id, classId), eq(classes.schoolId, schoolId)));
  must(c, 'Class');
}

/** Public or staff-entered enquiry. */
export async function submitEnquiry(db: Executor, schoolId: string, input: z.infer<typeof enquiryInput> & { source?: string }) {
  await assertClass(db, schoolId, input.classId);
  const [row] = await db.insert(admissionEnquiries).values({ ...input, schoolId, source: input.source ?? 'walk_in' }).returning();
  await notifyUsers(db, schoolId, await schoolAdmins(db, schoolId), {
    type: 'admission_enquiry',
    title: `New admission enquiry: ${input.studentName}`,
    body: `${input.guardianName} · ${input.phone}`,
    link: '/admissions?tab=enquiries',
  });
  return row;
}

export async function submitApplication(db: Executor, schoolId: string, input: z.infer<typeof applicationInput>) {
  await assertClass(db, schoolId, input.classId);
  const [s] = await db.select({ settings: schools.settings }).from(schools).where(eq(schools.id, schoolId));
  const [year] = await db.select({ id: academicYears.id }).from(academicYears).where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.isCurrent, true)));
  const applicationNo = await nextNumber(db, schoolId, 'application', s.settings.applicationNoFormat);
  const [row] = await db
    .insert(admissionApplications)
    .values({ ...input, schoolId, applicationNo, academicYearId: year?.id ?? null })
    .returning();
  if (input.enquiryId) {
    await db.update(admissionEnquiries).set({ status: 'converted' }).where(and(eq(admissionEnquiries.id, input.enquiryId), eq(admissionEnquiries.schoolId, schoolId)));
  }
  await notifyUsers(db, schoolId, await schoolAdmins(db, schoolId), {
    type: 'admission_application',
    title: `New application ${applicationNo}`,
    body: `${input.student.firstName} ${input.student.lastName ?? ''}`.trim(),
    link: `/admissions/applications/${row.id}`,
  });
  return row;
}

export const enquiryListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().optional(),
  status: z.enum(ENQUIRY_STATUSES).optional(),
});

export async function listEnquiries(ctx: Ctx, q: z.infer<typeof enquiryListQuery>) {
  requirePermission(ctx, 'admissions.view');
  const where = and(
    eq(admissionEnquiries.schoolId, ctx.schoolId),
    q.status ? eq(admissionEnquiries.status, q.status) : undefined,
    q.search ? or(ilike(admissionEnquiries.studentName, `%${q.search}%`), ilike(admissionEnquiries.guardianName, `%${q.search}%`), ilike(admissionEnquiries.phone, `%${q.search}%`)) : undefined,
  );
  const rows = await ctx.db
    .select({ enquiry: admissionEnquiries, className: classes.name })
    .from(admissionEnquiries)
    .leftJoin(classes, eq(classes.id, admissionEnquiries.classId))
    .where(where)
    .orderBy(desc(admissionEnquiries.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [{ n }] = await ctx.db.select({ n: count() }).from(admissionEnquiries).where(where);
  return { rows: rows.map((r) => ({ ...r.enquiry, className: r.className })), total: n };
}

export async function updateEnquiry(ctx: Ctx, id: string, body: { status: (typeof ENQUIRY_STATUSES)[number]; notes?: string | null }) {
  requirePermission(ctx, 'admissions.edit');
  const [row] = await ctx.db
    .update(admissionEnquiries)
    .set(body)
    .where(and(eq(admissionEnquiries.id, id), eq(admissionEnquiries.schoolId, ctx.schoolId)))
    .returning();
  return must(row, 'Enquiry');
}

export const applicationListQuery = enquiryListQuery.extend({ status: z.enum(APPLICATION_STATUSES).optional(), classId: z.uuid().optional() });

export async function listApplications(ctx: Ctx, q: z.infer<typeof applicationListQuery>) {
  requirePermission(ctx, 'admissions.view');
  const where = and(
    eq(admissionApplications.schoolId, ctx.schoolId),
    q.status ? eq(admissionApplications.status, q.status) : undefined,
    q.classId ? eq(admissionApplications.classId, q.classId) : undefined,
    q.search
      ? or(
          ilike(admissionApplications.applicationNo, `%${q.search}%`),
          ilike(sql`${admissionApplications.student}->>'firstName'`, `%${q.search}%`),
          ilike(sql`${admissionApplications.guardian}->>'name'`, `%${q.search}%`),
        )
      : undefined,
  );
  const rows = await ctx.db
    .select({ app: admissionApplications, className: classes.name })
    .from(admissionApplications)
    .innerJoin(classes, eq(classes.id, admissionApplications.classId))
    .where(where)
    .orderBy(desc(admissionApplications.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [{ n }] = await ctx.db.select({ n: count() }).from(admissionApplications).where(where);
  return { rows: rows.map((r) => ({ ...r.app, className: r.className })), total: n };
}

export async function getApplication(ctx: Ctx, id: string) {
  requirePermission(ctx, 'admissions.view');
  const [row] = await ctx.db
    .select({ app: admissionApplications, className: classes.name, yearName: academicYears.name })
    .from(admissionApplications)
    .innerJoin(classes, eq(classes.id, admissionApplications.classId))
    .leftJoin(academicYears, eq(academicYears.id, admissionApplications.academicYearId))
    .where(and(eq(admissionApplications.id, id), eq(admissionApplications.schoolId, ctx.schoolId)));
  must(row, 'Application');
  return { ...row.app, className: row.className, academicYear: row.yearName };
}

export async function reviewApplication(ctx: Ctx, id: string, body: { status: 'under_review' | 'approved' | 'rejected'; remarks?: string | null }) {
  requirePermission(ctx, body.status === 'under_review' ? 'admissions.edit' : 'admissions.approve');
  const app = await getApplication(ctx, id);
  if (app.status === 'enrolled') throw badRequest('This application has already been enrolled');
  const [row] = await ctx.db
    .update(admissionApplications)
    .set({ status: body.status, remarks: body.remarks ?? app.remarks, reviewedBy: ctx.userId, reviewedAt: new Date() })
    .where(eq(admissionApplications.id, id))
    .returning();
  await audit(ctx, `application_${body.status}`, 'application', id);
  return row;
}

/** Turns an approved application into a registered, enrolled student. */
export async function enrollApplication(ctx: Ctx, id: string, body: { sectionId: string; admissionNo?: string | null }) {
  requirePermission(ctx, 'admissions.approve');
  requirePermission(ctx, 'students.create');
  const app = await getApplication(ctx, id);
  if (app.status !== 'approved') throw badRequest('Only approved applications can be enrolled');
  const [sec] = await ctx.db.select().from(sections).where(and(eq(sections.id, body.sectionId), eq(sections.schoolId, ctx.schoolId)));
  must(sec, 'Section');
  if (sec.classId !== app.classId) throw badRequest('Choose a section of the class the student applied for');
  const student = await createStudent(ctx, {
    admissionNo: body.admissionNo ?? null,
    firstName: app.student.firstName,
    lastName: app.student.lastName ?? '',
    dateOfBirth: app.student.dateOfBirth ?? null,
    gender: (app.student.gender as any) ?? null,
    previousSchool: app.student.previousSchool ?? null,
    address: app.student.address ?? null,
    sectionId: sec.id,
    guardians: [
      {
        name: app.guardian.name,
        relation: app.guardian.relation ?? 'guardian',
        phone: app.guardian.phone,
        email: app.guardian.email ?? null,
        occupation: app.guardian.occupation ?? null,
        isPrimary: true,
      },
    ],
  });
  await ctx.db.update(admissionApplications).set({ status: 'enrolled', studentId: student.id }).where(eq(admissionApplications.id, id));
  // Move the uploaded application documents onto the student record.
  await ctx.db.execute(sql`update files set entity = 'student', entity_id = ${student.id} where school_id = ${ctx.schoolId} and entity = 'application' and entity_id = ${id}`);
  await audit(ctx, 'application_enrolled', 'application', id, { studentId: student.id });
  return { studentId: student.id, admissionNo: student.admissionNo };
}
