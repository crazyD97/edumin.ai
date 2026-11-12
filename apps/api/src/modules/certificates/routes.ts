import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { certificates, classes, enrollments, academicYears, roles, schools, sections, staffProfiles, students, users } from '../../db/schema';
import { db } from '../../core/db';
import { ctxOf, guard, idParam, ok, sendFile, typed, type App } from '../../core/http';
import { CERT_TYPES, certificateDefaults, certificatePdf, issueCertificate, issueInput, listCertificates, revokeCertificate, staffIdCards, studentIdCards, type CertType } from './service';

const F = { feature: 'certificates' as const };

export async function certificateRoutes(app: App) {
  const r = typed(app);

  r.get('/certificates', { preValidation: guard('certificates.view', F), schema: { tags: ['Certificates'], querystring: z.object({ studentId: z.uuid().optional(), type: z.string().optional() }) } }, async (req) =>
    ok(await listCertificates(ctxOf(req), req.query)),
  );
  r.get(
    '/students/:id/certificates/defaults',
    { preValidation: guard('certificates.view', F), schema: { tags: ['Certificates'], params: idParam, querystring: z.object({ type: z.enum(Object.keys(CERT_TYPES) as [CertType, ...CertType[]]) }) } },
    async (req) => ok(await certificateDefaults(ctxOf(req), req.params.id, req.query.type)),
  );
  r.post('/students/:id/certificates', { preValidation: guard('certificates.create', F), schema: { tags: ['Certificates'], params: idParam, body: issueInput } }, async (req) =>
    ok(await issueCertificate(ctxOf(req), req.params.id, req.body)),
  );
  r.get('/certificates/:id/pdf', { preValidation: guard('certificates.view', F), schema: { tags: ['Certificates'], params: idParam } }, async (req, reply) => {
    const { buffer, filename } = await certificatePdf(ctxOf(req), req.params.id);
    return sendFile(reply, buffer, filename, 'application/pdf');
  });
  r.post('/certificates/:id/revoke', { preValidation: guard('certificates.delete', F), schema: { tags: ['Certificates'], params: idParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) } }, async (req) =>
    ok(await revokeCertificate(ctxOf(req), req.params.id, req.body.reason)),
  );

  r.get('/id-cards/students', { preValidation: guard('certificates.view', F), schema: { tags: ['Certificates'], querystring: z.object({ sectionId: z.uuid().optional(), studentIds: z.string().optional() }) } }, async (req, reply) => {
    const { buffer, filename } = await studentIdCards(ctxOf(req), { sectionId: req.query.sectionId, studentIds: req.query.studentIds?.split(',').filter(Boolean) });
    return sendFile(reply, buffer, filename, 'application/pdf');
  });
  r.get('/id-cards/staff', { preValidation: guard(['certificates.view', 'staff.view'], F), schema: { tags: ['Certificates'], querystring: z.object({ userIds: z.string().optional() }) } }, async (req, reply) => {
    const { buffer, filename } = await staffIdCards(ctxOf(req), req.query.userIds?.split(',').filter(Boolean));
    return sendFile(reply, buffer, filename, 'application/pdf');
  });
}

/**
 * Public verification (the QR codes on certificates and ID cards). Shows only
 * what is needed to confirm authenticity — no contact details.
 */
export async function verifyRoutes(app: App) {
  const r = typed(app);
  const limit = { rateLimit: { max: 60, timeWindow: '1 minute' } };
  const schoolInfo = async (schoolId: string) => {
    const [s] = await db.select({ name: schools.name, status: schools.status, logoUrl: sql<string | null>`${schools.branding}->>'logoUrl'`, primaryColor: sql<string>`${schools.branding}->>'primaryColor'` }).from(schools).where(eq(schools.id, schoolId));
    return s;
  };

  r.get('/public/verify/certificate/:id', { config: limit, schema: { tags: ['Public'], params: idParam } }, async (req) => {
    const [c] = await db
      .select({ c: certificates, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, admissionNo: students.admissionNo })
      .from(certificates)
      .innerJoin(students, eq(students.id, certificates.studentId))
      .where(eq(certificates.id, req.params.id));
    if (!c) return ok({ valid: false });
    return ok({
      valid: !c.c.revokedAt,
      kind: 'certificate',
      school: await schoolInfo(c.c.schoolId),
      title: CERT_TYPES[c.c.type as CertType]?.title ?? c.c.type,
      serialNo: c.c.serialNo,
      issuedAt: c.c.issuedAt,
      revokedAt: c.c.revokedAt,
      revokeReason: c.c.revokeReason,
      holder: c.name,
      admissionNo: c.admissionNo,
      details: c.c.type === 'transfer' ? { 'Class last studied': c.c.data.lastClass ?? c.c.data.currentClass, 'Date of leaving': c.c.data.dateOfLeaving } : { Class: c.c.data.currentClass },
    });
  });

  r.get('/public/verify/student/:id', { config: limit, schema: { tags: ['Public'], params: idParam } }, async (req) => {
    const [s] = await db
      .select({ s: students, className: classes.name, sectionName: sections.name, year: academicYears.name })
      .from(students)
      .leftJoin(enrollments, eq(enrollments.studentId, students.id))
      .leftJoin(academicYears, and(eq(academicYears.id, enrollments.academicYearId), eq(academicYears.isCurrent, true)))
      .leftJoin(sections, and(eq(sections.id, enrollments.sectionId), eq(sections.academicYearId, academicYears.id)))
      .leftJoin(classes, eq(classes.id, sections.classId))
      .where(eq(students.id, req.params.id))
      .orderBy(sql`${academicYears.isCurrent} desc nulls last`)
      .limit(1);
    if (!s) return ok({ valid: false });
    return ok({
      valid: s.s.status === 'active',
      kind: 'student',
      school: await schoolInfo(s.s.schoolId),
      title: 'Student ID card',
      holder: `${s.s.firstName} ${s.s.lastName}`.trim(),
      admissionNo: s.s.admissionNo,
      status: s.s.status,
      details: { Class: s.className ? `${s.className} - ${s.sectionName}` : null, 'Academic year': s.year },
    });
  });

  r.get('/public/verify/staff/:id', { config: limit, schema: { tags: ['Public'], params: idParam } }, async (req) => {
    const [u] = await db
      .select({ u: users, designation: staffProfiles.designation, roleName: roles.name })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
      .where(and(eq(users.id, req.params.id), sql`${roles.key} not in ('student','parent')`));
    if (!u || !u.u.schoolId) return ok({ valid: false });
    return ok({
      valid: u.u.isActive,
      kind: 'staff',
      school: await schoolInfo(u.u.schoolId),
      title: 'Staff ID card',
      holder: u.u.fullName,
      status: u.u.isActive ? 'active' : 'inactive',
      details: { Role: u.designation ?? u.roleName },
    });
  });
}
