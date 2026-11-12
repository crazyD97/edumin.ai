/**
 * Global search (Ctrl+K). Each group only appears when the caller has the
 * permission, and students are limited to the caller's data scope.
 */
import { z } from 'zod';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { admissionApplications, certificates, guardians, payments, roles, studentGuardians, students, users } from '../../db/schema';
import { ctxOf, guard, ok, typed, type App } from '../../core/http';
import { can, scopedStudentIds } from '../../core/context';

const LIMIT = 6;

export async function searchRoutes(app: App) {
  typed(app).get(
    '/search',
    { preValidation: guard(), schema: { tags: ['Search'], querystring: z.object({ q: z.string().trim().min(2).max(100) }) } },
    async (req) => {
      const ctx = ctxOf(req);
      const q = req.query.q;
      const like = `%${q}%`;
      const digits = q.replace(/\D/g, '');
      const groups: { type: string; label: string; items: { id: string; title: string; subtitle: string; link: string }[] }[] = [];

      if (can(ctx, 'students.view') || ctx.scope === 'own') {
        const scoped = await scopedStudentIds(ctx);
        if (!scoped || scoped.length) {
          const viaGuardian = digits.length >= 5 || q.length >= 3
            ? ctx.db
                .select({ id: studentGuardians.studentId })
                .from(studentGuardians)
                .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
                .where(and(eq(guardians.schoolId, ctx.schoolId), or(ilike(guardians.name, like), digits.length >= 5 ? ilike(guardians.phone, `%${digits}%`) : sql`false`)))
            : null;
          const rows = await ctx.db
            .select({
              id: students.id,
              name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
              admissionNo: students.admissionNo,
              status: students.status,
              cls: sql<string | null>`(select c.name || ' - ' || s.name from enrollments e join sections s on s.id = e.section_id join classes c on c.id = s.class_id join academic_years y on y.id = e.academic_year_id and y.is_current where e.student_id = "students"."id" limit 1)`,
            })
            .from(students)
            .where(
              and(
                eq(students.schoolId, ctx.schoolId),
                scoped ? inArray(students.id, scoped) : undefined,
                or(
                  ilike(sql`${students.firstName} || ' ' || ${students.lastName}`, like),
                  ilike(students.admissionNo, like),
                  digits.length >= 5 ? ilike(students.phone, `%${digits}%`) : sql`false`,
                  viaGuardian ? inArray(students.id, viaGuardian) : sql`false`,
                ),
              ),
            )
            .orderBy(sql`${students.status} = 'active' desc`, students.firstName)
            .limit(LIMIT);
          if (rows.length)
            groups.push({
              type: 'student',
              label: 'Students',
              items: rows.map((r) => ({ id: r.id, title: r.name.trim(), subtitle: [r.admissionNo, r.cls, r.status !== 'active' ? r.status : null].filter(Boolean).join(' · '), link: ctx.scope === 'own' ? `/fees/students/${r.id}` : `/students/${r.id}` })),
            });
        }
      }

      if (can(ctx, 'staff.view')) {
        const rows = await ctx.db
          .select({ id: users.id, name: users.fullName, email: users.email, phone: users.phone, role: roles.name })
          .from(users)
          .innerJoin(roles, eq(roles.id, users.roleId))
          .where(and(eq(users.schoolId, ctx.schoolId), sql`${roles.key} not in ('student','parent')`, or(ilike(users.fullName, like), ilike(users.email, like), digits.length >= 5 ? ilike(users.phone, `%${digits}%`) : sql`false`)))
          .limit(LIMIT);
        if (rows.length) groups.push({ type: 'staff', label: 'Staff', items: rows.map((r) => ({ id: r.id, title: r.name, subtitle: `${r.role}${r.email ? ` · ${r.email}` : ''}`, link: `/staff?search=${encodeURIComponent(r.name)}` })) });
      }

      if (can(ctx, 'fees.view') && ctx.scope === 'school') {
        const rows = await ctx.db
          .select({ id: payments.id, receiptNo: payments.receiptNo, amount: payments.amount, studentId: payments.studentId, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}` })
          .from(payments)
          .innerJoin(students, eq(students.id, payments.studentId))
          .where(and(eq(payments.schoolId, ctx.schoolId), ilike(payments.receiptNo, like)))
          .orderBy(desc(payments.paidAt))
          .limit(LIMIT);
        if (rows.length) groups.push({ type: 'receipt', label: 'Receipts', items: rows.map((r) => ({ id: r.id, title: r.receiptNo, subtitle: `₹${r.amount.toLocaleString('en-IN')} · ${r.name}`, link: `/fees/students/${r.studentId}` })) });
      }

      if (can(ctx, 'admissions.view') && ctx.features.has('admissions')) {
        const rows = await ctx.db
          .select({ id: admissionApplications.id, no: admissionApplications.applicationNo, student: admissionApplications.student, status: admissionApplications.status })
          .from(admissionApplications)
          .where(and(eq(admissionApplications.schoolId, ctx.schoolId), or(ilike(admissionApplications.applicationNo, like), ilike(sql`${admissionApplications.student}->>'firstName'`, like))))
          .limit(LIMIT);
        if (rows.length) groups.push({ type: 'application', label: 'Admission applications', items: rows.map((r) => ({ id: r.id, title: `${r.student.firstName} ${r.student.lastName ?? ''}`.trim(), subtitle: `${r.no} · ${r.status.replace('_', ' ')}`, link: `/admissions/applications/${r.id}` })) });
      }

      if (can(ctx, 'certificates.view') && ctx.features.has('certificates') && ctx.scope === 'school') {
        const rows = await ctx.db
          .select({ id: certificates.id, serialNo: certificates.serialNo, studentId: certificates.studentId, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}` })
          .from(certificates)
          .innerJoin(students, eq(students.id, certificates.studentId))
          .where(and(eq(certificates.schoolId, ctx.schoolId), ilike(certificates.serialNo, like)))
          .limit(LIMIT);
        if (rows.length) groups.push({ type: 'certificate', label: 'Certificates', items: rows.map((r) => ({ id: r.id, title: r.serialNo, subtitle: r.name, link: `/students/${r.studentId}` })) });
      }

      return ok(groups);
    },
  );
}
