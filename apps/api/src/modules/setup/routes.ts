/**
 * Onboarding: a checklist computed from real data, plus bulk actions that
 * turn an empty school into a working one quickly (class structure, staff
 * import, parent app logins).
 */
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { CHANNELS, normalizeIndianMobile, type Channel } from '@edumin/shared';
import {
  classes,
  enrollments,
  feeStructures,
  guardians,
  roles,
  schoolIntegrations,
  schools,
  sectionSubjects,
  sections,
  staffProfiles,
  studentGuardians,
  students,
  subjects,
  users,
} from '../../db/schema';
import { badRequest } from '../../core/errors';
import { ctxOf, guard, ok, typed, type App } from '../../core/http';
import { currentYearId, requirePermission, type Ctx } from '../../core/context';
import { hashPassword } from '../../core/auth';
import { friendlyPassword } from '../../core/crypto';
import { publicUrl } from '../../core/env';
import { audit } from '../../core/audit';
import { createDoc, footer, letterhead, loadSchoolHeader, toBuffer } from '../../core/pdf';
import { dispatch } from '../messaging/service';
import { resolveYearId } from '../academics/routes';

async function status(ctx: Ctx) {
  const yearId = await currentYearId(ctx);
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0].n;
  const [school] = await ctx.db.select().from(schools).where(eq(schools.id, ctx.schoolId));
  const [cls, secs, subs, alloc, teachers, studs, fees, guardiansTotal, guardiansWithLogin, rz] = await Promise.all([
    n(ctx.db.select({ n: count() }).from(classes).where(eq(classes.schoolId, ctx.schoolId))),
    n(ctx.db.select({ n: count() }).from(sections).where(and(eq(sections.schoolId, ctx.schoolId), yearId ? eq(sections.academicYearId, yearId) : sql`false`))),
    n(ctx.db.select({ n: count() }).from(subjects).where(eq(subjects.schoolId, ctx.schoolId))),
    n(ctx.db.select({ n: count() }).from(sectionSubjects).where(eq(sectionSubjects.schoolId, ctx.schoolId))),
    n(ctx.db.select({ n: count() }).from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(and(eq(users.schoolId, ctx.schoolId), eq(roles.key, 'teacher'), eq(users.isActive, true)))),
    n(ctx.db.select({ n: count() }).from(students).where(and(eq(students.schoolId, ctx.schoolId), eq(students.status, 'active')))),
    n(ctx.db.select({ n: count() }).from(feeStructures).where(eq(feeStructures.schoolId, ctx.schoolId))),
    n(ctx.db.select({ n: count() }).from(guardians).where(eq(guardians.schoolId, ctx.schoolId))),
    n(ctx.db.select({ n: count() }).from(guardians).where(and(eq(guardians.schoolId, ctx.schoolId), sql`${guardians.userId} is not null`))),
    n(ctx.db.select({ n: count() }).from(schoolIntegrations).where(and(eq(schoolIntegrations.schoolId, ctx.schoolId), eq(schoolIntegrations.provider, 'razorpay'), eq(schoolIntegrations.enabled, true)))),
  ]);
  const b = school.branding;
  const items = [
    { key: 'profile', label: 'School profile & branding', done: !!(b.logoUrl && b.phone && b.address), detail: b.logoUrl ? 'Logo uploaded' : 'Add your logo, address and phone', link: '/settings?tab=branding' },
    { key: 'year', label: 'Academic year', done: !!yearId, detail: yearId ? 'Current year set' : 'Set the current academic year', link: '/academics?tab=years' },
    { key: 'classes', label: 'Classes, sections & subjects', done: cls > 0 && secs > 0 && subs > 0, detail: `${cls} classes · ${secs} sections · ${subs} subjects`, action: 'classes' },
    { key: 'staff', label: 'Teachers & staff', done: teachers > 0, detail: `${teachers} teachers`, action: 'staff' },
    { key: 'allocation', label: 'Class & subject teachers', done: alloc > 0, detail: alloc ? `${alloc} subject allocations` : 'Assign teachers to sections', link: '/academics' },
    { key: 'students', label: 'Students', done: studs > 0, detail: `${studs} active students`, link: '/students' },
    { key: 'fees', label: 'Fee structure', done: fees > 0, detail: fees ? `${fees} fee structures` : 'Add tuition and other fees', link: '/fees?tab=structures' },
    { key: 'payments', label: 'Online fee payments (Razorpay)', done: rz > 0, detail: rz ? 'Connected' : 'Connect your Razorpay account', link: '/settings?tab=integrations', optional: true },
    { key: 'messaging', label: 'WhatsApp & SMS alerts', done: school.messaging.channels.whatsapp || school.messaging.channels.sms, detail: `${school.messageCredits} credits`, link: '/messaging', optional: true },
    { key: 'parents', label: 'Parent app logins', done: guardiansTotal > 0 && guardiansWithLogin / guardiansTotal >= 0.5, detail: `${guardiansWithLogin} of ${guardiansTotal} parents can sign in`, action: 'parents' },
  ];
  const required = items.filter((i) => !i.optional);
  return { items, completed: items.filter((i) => i.done).length, total: items.length, ready: required.every((i) => i.done) };
}

const CLASS_PRESET = ['Nursery', 'LKG', 'UKG', ...Array.from({ length: 12 }, (_, i) => `Class ${i + 1}`)];
const SUBJECT_PRESET = ['English', 'Hindi', 'Mathematics', 'Science', 'Social Science', 'Computer Science', 'EVS', 'Sanskrit', 'Art', 'Physical Education'];

const STAFF_COLUMNS = ['fullName', 'email', 'phone', 'role', 'employeeCode', 'designation', 'department', 'password'] as const;

async function parseSheet(buf: Buffer, filename: string) {
  const wb = new ExcelJS.Workbook();
  if (filename.toLowerCase().endsWith('.csv')) {
    const { Readable } = await import('node:stream');
    await wb.csv.read(Readable.from(buf.toString('utf8').replace(/^﻿/, '')));
  } else await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest('The file has no sheets');
  const header = (ws.getRow(1).values as unknown[]).slice(1).map((h) => String(h ?? '').trim());
  const out: Record<string, string>[] = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const vals = (row.values as unknown[]).slice(1);
    const rec = Object.fromEntries(header.map((h, j) => [h, vals[j] === null || vals[j] === undefined ? '' : String(typeof vals[j] === 'object' && vals[j] && 'text' in (vals[j] as any) ? (vals[j] as any).text : vals[j]).trim()]));
    if (Object.values(rec).some(Boolean)) out.push(rec);
  });
  return out;
}

/** Credential slips: one block per person with their login and temporary password. */
async function credentialSlips(ctx: Ctx, title: string, rows: { name: string; subtitle: string; login: string; password: string }[]) {
  const h = await loadSchoolHeader(ctx.schoolId);
  const doc = createDoc();
  let y = letterhead(doc, h, title, 'Cut along the lines and hand each person their slip. Ask them to change the password after signing in.');
  const left = doc.page.margins.left;
  const width = doc.page.width - left * 2;
  const url = publicUrl();
  const [{ slug }] = await ctx.db.select({ slug: schools.slug }).from(schools).where(eq(schools.id, ctx.schoolId));
  for (const r of rows) {
    if (y + 78 > doc.page.height - 50) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.rect(left, y, width, 70).dash(3, { space: 3 }).lineWidth(0.6).strokeColor('#94a3b8').stroke().undash();
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(r.name, left + 12, y + 10, { width: width * 0.55 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#64748b').text(r.subtitle, left + 12, y + 26, { width: width * 0.55 });
    doc.text(`Open: ${url}  ·  School code: ${slug}`, left + 12, y + 44, { width: width * 0.6 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#64748b').text('Login', left + width * 0.62, y + 12);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(r.login, left + width * 0.62, y + 23, { width: width * 0.36 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#64748b').text('Temporary password', left + width * 0.62, y + 40);
    doc.font('Courier-Bold').fontSize(12).fillColor('#0f172a').text(r.password, left + width * 0.62, y + 51);
    y += 80;
  }
  footer(doc, h, 'Confidential — contains login details');
  return (await toBuffer(doc)).toString('base64');
}

export async function setupRoutes(app: App) {
  const r = typed(app);

  r.get('/setup/status', { preValidation: guard('settings.view'), schema: { tags: ['Setup'], summary: 'Onboarding checklist computed from the school’s data' } }, async (req) => ok(await status(ctxOf(req))));

  r.get('/setup/presets', { preValidation: guard('academics.view'), schema: { tags: ['Setup'] } }, async () => ok({ classes: CLASS_PRESET, subjects: SUBJECT_PRESET }));

  r.post(
    '/setup/classes',
    {
      preValidation: guard(['academics.create', 'academics.edit']),
      schema: {
        tags: ['Setup'],
        summary: 'Create classes, sections (current year) and subjects in one go; existing ones are kept',
        body: z.object({ classes: z.array(z.string().trim().min(1).max(50)).min(1).max(30), sections: z.array(z.string().trim().min(1).max(10)).min(1).max(10), subjects: z.array(z.string().trim().min(1).max(100)).max(40).default([]) }),
      },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const yearId = await resolveYearId(ctx, null);
      const result = { classes: 0, sections: 0, subjects: 0 };
      await ctx.db.transaction(async (tx) => {
        const existing = await tx.select().from(classes).where(eq(classes.schoolId, ctx.schoolId));
        const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
        const maxLevel = existing.reduce((m, c) => Math.max(m, c.level), 0);
        const classRows: (typeof classes.$inferSelect)[] = [];
        for (const [i, name] of req.body.classes.entries()) {
          let c = byName.get(name.toLowerCase());
          if (!c) {
            [c] = await tx.insert(classes).values({ schoolId: ctx.schoolId, name, level: maxLevel + i + 1 }).returning();
            result.classes++;
          }
          classRows.push(c);
        }
        const subjectRows: (typeof subjects.$inferSelect)[] = [];
        for (const name of req.body.subjects) {
          const [s] = await tx.insert(subjects).values({ schoolId: ctx.schoolId, name }).onConflictDoNothing().returning();
          if (s) result.subjects++;
          subjectRows.push(s ?? (await tx.select().from(subjects).where(and(eq(subjects.schoolId, ctx.schoolId), eq(subjects.name, name))))[0]);
        }
        for (const c of classRows)
          for (const name of req.body.sections) {
            const [sec] = await tx.insert(sections).values({ schoolId: ctx.schoolId, academicYearId: yearId, classId: c.id, name }).onConflictDoNothing().returning();
            if (!sec) continue;
            result.sections++;
            if (subjectRows.length) await tx.insert(sectionSubjects).values(subjectRows.map((s) => ({ schoolId: ctx.schoolId, sectionId: sec.id, subjectId: s.id }))).onConflictDoNothing();
          }
      });
      await audit(ctx, 'setup', 'classes', null, result);
      return ok(result);
    },
  );

  r.get('/staff/import-template', { preValidation: guard('staff.create'), schema: { tags: ['Setup'] } }, async (_req, reply) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Staff');
    ws.columns = STAFF_COLUMNS.map((c) => ({ header: c, key: c, width: 20 }));
    ws.addRow({ fullName: 'Kavya Sharma', email: 'kavya@school.edu', phone: '9876500011', role: 'teacher', employeeCode: 'T014', designation: 'TGT Mathematics', department: 'Mathematics', password: '' });
    ws.getRow(1).font = { bold: true };
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="staff-import-template.xlsx"')
      .send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  r.post(
    '/staff/import',
    { preValidation: guard('staff.create'), schema: { tags: ['Setup'], summary: 'multipart CSV/XLSX; blank passwords are generated', querystring: z.object({ dryRun: z.enum(['true', 'false']).default('true') }) } },
    async (req) => {
      const ctx = ctxOf(req);
      const part = await req.file({ limits: { fileSize: 2 * 1024 * 1024 } });
      if (!part) throw badRequest('Upload a CSV or Excel file');
      const rows = await parseSheet(await part.toBuffer(), part.filename);
      if (!rows.length) throw badRequest('The file has no data rows');
      if (rows.length > 500) throw badRequest('Import at most 500 staff at a time');
      const roleRows = await ctx.db.select().from(roles).where(and(eq(roles.schoolId, ctx.schoolId), sql`${roles.key} not in ('student','parent')`));
      const roleByName = new Map(roleRows.flatMap((r) => [[r.key.toLowerCase(), r], [r.name.toLowerCase(), r]]));
      const existing = await ctx.db.select({ email: users.email, phone: users.phone }).from(users).where(eq(users.schoolId, ctx.schoolId));
      const emails = new Set(existing.map((e) => e.email?.toLowerCase()).filter(Boolean));
      const phones = new Set(existing.map((e) => normalizeIndianMobile(e.phone)).filter(Boolean));
      const errors: { row: number; message: string }[] = [];
      const valid: { row: Record<string, string>; roleId: string; email: string | null; phone: string | null }[] = [];
      rows.forEach((raw, i) => {
        const rowNo = i + 2;
        const role = roleByName.get((raw.role || 'teacher').toLowerCase());
        const email = raw.email ? raw.email.toLowerCase() : null;
        const phone = raw.phone ? normalizeIndianMobile(raw.phone) : null;
        if (!raw.fullName || raw.fullName.length < 2) errors.push({ row: rowNo, message: 'fullName is required' });
        else if (!role) errors.push({ row: rowNo, message: `Unknown role "${raw.role}" — use one of: ${roleRows.map((r) => r.key).join(', ')}` });
        else if (!email && !phone) errors.push({ row: rowNo, message: 'Give an email or a valid mobile number to sign in with' });
        else if (email && !/^\S+@\S+\.\S+$/.test(email)) errors.push({ row: rowNo, message: `Invalid email "${raw.email}"` });
        else if (raw.phone && !phone) errors.push({ row: rowNo, message: `Invalid mobile number "${raw.phone}"` });
        else if (email && emails.has(email)) errors.push({ row: rowNo, message: `${email} already has an account` });
        else if (phone && phones.has(phone)) errors.push({ row: rowNo, message: `${raw.phone} already has an account` });
        else if (raw.password && raw.password.length < 8) errors.push({ row: rowNo, message: 'Passwords must be at least 8 characters' });
        else {
          if (email) emails.add(email);
          if (phone) phones.add(phone);
          valid.push({ row: raw, roleId: role.id, email, phone: phone ? phone.slice(2) : null });
        }
      });
      if (errors.length || req.query.dryRun === 'true') return ok({ valid: valid.length, imported: 0, errors, slipsPdf: null });
      const creds: { name: string; subtitle: string; login: string; password: string }[] = [];
      await ctx.db.transaction(async (tx) => {
        for (const v of valid) {
          const password = v.row.password || friendlyPassword();
          const [u] = await tx
            .insert(users)
            .values({ schoolId: ctx.schoolId, roleId: v.roleId, fullName: v.row.fullName, email: v.email, phone: v.phone, passwordHash: await hashPassword(password) })
            .returning();
          await tx.insert(staffProfiles).values({ userId: u.id, schoolId: ctx.schoolId, employeeCode: v.row.employeeCode || null, designation: v.row.designation || null, department: v.row.department || null });
          creds.push({ name: v.row.fullName, subtitle: v.row.designation || roleRows.find((r) => r.id === v.roleId)!.name, login: v.email ?? v.phone!, password });
        }
      });
      await audit(ctx, 'import', 'staff', null, { imported: creds.length });
      return ok({ valid: valid.length, imported: creds.length, errors: [], slipsPdf: await credentialSlips(ctx, 'Staff login details', creds) });
    },
  );

  r.post(
    '/guardians/portal-accounts/bulk',
    {
      preValidation: guard('students.edit'),
      schema: {
        tags: ['Setup'],
        summary: 'Create parent app logins (mobile number + generated password) for parents who don’t have one',
        body: z.object({ sectionId: z.uuid().optional(), sendVia: z.array(z.enum(CHANNELS)).default([]), dryRun: z.boolean().default(false) }),
      },
    },
    async (req) => {
      const ctx = ctxOf(req);
      requirePermission(ctx, 'students.edit');
      const yearId = await currentYearId(ctx);
      const [parentRole] = await ctx.db.select().from(roles).where(and(eq(roles.schoolId, ctx.schoolId), eq(roles.key, 'parent')));
      // Guardians of active students (optionally one section) with no login yet.
      const rows = await ctx.db
        .select({ g: guardians, studentName: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, cls: sql<string | null>`(select c.name || ' - ' || s.name from sections s join classes c on c.id = s.class_id where s.id = ${enrollments.sectionId})` })
        .from(guardians)
        .innerJoin(studentGuardians, eq(studentGuardians.guardianId, guardians.id))
        .innerJoin(students, and(eq(students.id, studentGuardians.studentId), eq(students.status, 'active')))
        .leftJoin(enrollments, and(eq(enrollments.studentId, students.id), yearId ? eq(enrollments.academicYearId, yearId) : sql`false`))
        .where(and(eq(guardians.schoolId, ctx.schoolId), isNull(guardians.userId), eq(studentGuardians.isPrimary, true), req.body.sectionId ? eq(enrollments.sectionId, req.body.sectionId) : undefined))
        .orderBy(asc(guardians.name));
      const byGuardian = new Map<string, { g: typeof guardians.$inferSelect; children: string[] }>();
      for (const r of rows) {
        const e = byGuardian.get(r.g.id) ?? { g: r.g, children: [] };
        e.children.push(`${r.studentName.trim()}${r.cls ? ` (${r.cls})` : ''}`);
        byGuardian.set(r.g.id, e);
      }
      const taken = new Set(
        (await ctx.db.select({ phone: users.phone, email: users.email }).from(users).where(eq(users.schoolId, ctx.schoolId))).flatMap((u) => [normalizeIndianMobile(u.phone), u.email?.toLowerCase()]).filter(Boolean),
      );
      const plan: { g: typeof guardians.$inferSelect; children: string[]; phone: string }[] = [];
      const skipped: { name: string; reason: string }[] = [];
      for (const e of byGuardian.values()) {
        const phone = normalizeIndianMobile(e.g.phone);
        if (!phone) skipped.push({ name: e.g.name, reason: 'No valid mobile number' });
        else if (taken.has(phone)) skipped.push({ name: e.g.name, reason: 'Mobile number already used by another account' });
        else {
          taken.add(phone);
          plan.push({ ...e, phone });
        }
      }
      if (req.body.dryRun) return ok({ eligible: plan.length, skipped, created: 0, slipsPdf: null, messages: null });
      const creds: { name: string; subtitle: string; login: string; password: string; phone: string; email: string | null }[] = [];
      for (const p of plan) {
        const password = friendlyPassword();
        const email = p.g.email && !taken.has(p.g.email.toLowerCase()) ? p.g.email.toLowerCase() : null;
        if (email) taken.add(email);
        await ctx.db.transaction(async (tx) => {
          const [u] = await tx
            .insert(users)
            .values({ schoolId: ctx.schoolId, roleId: parentRole.id, fullName: p.g.name, phone: p.phone.slice(2), email, passwordHash: await hashPassword(password) })
            .returning();
          await tx.update(guardians).set({ userId: u.id }).where(eq(guardians.id, p.g.id));
        });
        creds.push({ name: p.g.name, subtitle: `Parent of ${p.children.join(', ')}`, login: p.phone.slice(2), password, phone: p.phone, email });
      }
      let messages = null;
      if (req.body.sendVia.length && creds.length) {
        messages = await dispatch(ctx.db, ctx.schoolId, {
          event: 'portal_credentials',
          channels: req.body.sendVia as Channel[],
          createdBy: ctx.userId,
          items: creds.map((c) => ({ recipient: { name: c.name, phone: c.phone, email: c.email }, vars: { name: c.name, login: c.login, password: c.password, link: publicUrl() } })),
        });
      }
      await audit(ctx, 'bulk_create', 'parent_logins', null, { created: creds.length, sent: messages?.queued ?? 0 });
      return ok({ eligible: plan.length, skipped, created: creds.length, slipsPdf: creds.length ? await credentialSlips(ctx, 'Parent app login details', creds) : null, messages });
    },
  );
}

