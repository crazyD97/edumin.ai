/**
 * Certificates (Transfer, Bonafide, Character, Study) and ID cards.
 *
 * Every certificate gets a per-type serial number and a QR code that opens a
 * public verification page, so a receiving school can confirm it is genuine.
 * The certificate's data is snapshotted at issue time and reprints are exact.
 */
import { z } from 'zod';
import QRCode from 'qrcode';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { academicYears, certificates, classes, enrollments, guardians, roles, sectionSubjects, sections, staffProfiles, studentGuardians, students, subjects, users } from '../../db/schema';
import { requirePermission, assertStudentAccess, withTx, type Ctx } from '../../core/context';
import { badRequest, must } from '../../core/errors';
import { nextNumber } from '../../core/sequence';
import { publicUrl } from '../../core/env';
import { audit } from '../../core/audit';
import { createDoc, footer, letterhead, loadImage, loadSchoolHeader, toBuffer, type Doc, type SchoolHeader } from '../../core/pdf';
import { changeStatus } from '../students/service';

export const CERT_TYPES = {
  transfer: { title: 'Transfer Certificate', short: 'TC', prefix: 'TC' },
  bonafide: { title: 'Bonafide Certificate', short: 'Bonafide', prefix: 'BC' },
  character: { title: 'Character Certificate', short: 'Character', prefix: 'CC' },
  study: { title: 'Study Certificate', short: 'Study', prefix: 'SC' },
} as const;
export type CertType = keyof typeof CERT_TYPES;

export const issueInput = z.object({
  type: z.enum(Object.keys(CERT_TYPES) as [CertType, ...CertType[]]),
  fields: z.record(z.string(), z.string().trim().max(500).nullish()).default({}),
  /** Transfer certificates only: mark the student as transferred out. */
  markTransferred: z.boolean().default(false),
});

// ── Numbers to words (for date of birth on TCs) ──
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const ORD: Record<string, string> = { One: 'First', Two: 'Second', Three: 'Third', Five: 'Fifth', Eight: 'Eighth', Nine: 'Ninth', Twelve: 'Twelfth' };
function words(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + words(n % 100) : '');
  return words(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + words(n % 1000) : '');
}
function ordinal(n: number) {
  const w = words(n);
  const parts = w.split('-');
  const last = parts.pop()!;
  const ord = ORD[last] ?? (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th');
  return [...parts, ord].join('-');
}
export function dateInWords(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  return `${ordinal(d.getDate())} ${d.toLocaleString('en-IN', { month: 'long' })} ${words(d.getFullYear())}`;
}
const fmt = (iso?: string | null) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

/** Facts about the student used to prefill and snapshot a certificate. */
async function studentFacts(ctx: Ctx, studentId: string) {
  const [s] = await ctx.db.select().from(students).where(and(eq(students.id, studentId), eq(students.schoolId, ctx.schoolId)));
  must(s, 'Student');
  const gs = await ctx.db
    .select({ name: guardians.name, relation: guardians.relation })
    .from(studentGuardians)
    .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .where(eq(studentGuardians.studentId, studentId));
  const history = await ctx.db
    .select({ year: academicYears.name, isCurrent: academicYears.isCurrent, className: classes.name, sectionName: sections.name, sectionId: sections.id, status: enrollments.status, start: academicYears.startDate })
    .from(enrollments)
    .innerJoin(academicYears, eq(academicYears.id, enrollments.academicYearId))
    .innerJoin(sections, eq(sections.id, enrollments.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(eq(enrollments.studentId, studentId))
    .orderBy(asc(academicYears.startDate));
  const last = history.at(-1);
  const first = history[0];
  const subs = last
    ? await ctx.db.select({ name: subjects.name }).from(sectionSubjects).innerJoin(subjects, eq(subjects.id, sectionSubjects.subjectId)).where(eq(sectionSubjects.sectionId, last.sectionId)).orderBy(asc(subjects.name))
    : [];
  return {
    student: s,
    name: `${s.firstName} ${s.lastName}`.trim(),
    father: gs.find((g) => g.relation === 'father')?.name ?? null,
    mother: gs.find((g) => g.relation === 'mother')?.name ?? null,
    guardian: gs[0]?.name ?? null,
    currentClass: last ? `${last.className} - ${last.sectionName}` : null,
    currentYear: last?.year ?? null,
    firstClass: first ? first.className : null,
    subjects: subs.map((x) => x.name).join(', '),
  };
}

/** Field defaults shown in the issue form. */
export async function certificateDefaults(ctx: Ctx, studentId: string, type: CertType) {
  requirePermission(ctx, 'certificates.view');
  const f = await studentFacts(ctx, studentId);
  const today = new Date().toISOString().slice(0, 10);
  const common = { purpose: '', conduct: 'Good', remarks: '' };
  if (type === 'transfer')
    return {
      dateOfLeaving: f.student.exitDate ?? today,
      reasonForLeaving: f.student.exitReason ?? "Parent's request",
      lastClass: f.currentClass ?? '',
      qualifiedForPromotion: 'Yes',
      feesPaidUpTo: '',
      subjectsStudied: f.subjects,
      conduct: 'Good',
      remarks: '',
    };
  if (type === 'bonafide') return { ...common, purpose: 'Opening a bank account' };
  if (type === 'study') return { ...common, studiedFrom: f.student.admissionDate ?? '', studiedTo: today };
  return common;
}

export async function issueCertificate(ctx: Ctx, studentId: string, v: z.infer<typeof issueInput>) {
  requirePermission(ctx, 'certificates.create');
  const facts = await studentFacts(ctx, studentId);
  const s = facts.student;
  const snapshot: Record<string, string | null> = {
    name: facts.name,
    admissionNo: s.admissionNo,
    father: facts.father,
    mother: facts.mother,
    guardian: facts.guardian,
    dateOfBirth: s.dateOfBirth,
    dateOfBirthWords: s.dateOfBirth ? dateInWords(s.dateOfBirth) : null,
    gender: s.gender,
    nationality: s.nationality ?? 'Indian',
    religion: s.religion,
    admissionDate: s.admissionDate,
    firstClass: facts.firstClass,
    currentClass: facts.currentClass,
    academicYear: facts.currentYear,
    ...Object.fromEntries(Object.entries(v.fields).map(([k, val]) => [k, val ?? null])),
  };
  const row = await ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    const serialNo = await nextNumber(tx, ctx.schoolId, `cert_${v.type}`, `${CERT_TYPES[v.type].prefix}/{YYYY}/{SEQ:4}`);
    const [c] = await tx.insert(certificates).values({ schoolId: ctx.schoolId, studentId, type: v.type, serialNo, data: snapshot, issuedBy: ctx.userId }).returning();
    if (v.type === 'transfer' && v.markTransferred && s.status === 'active') {
      await changeStatus(t, studentId, { status: 'transferred', date: v.fields.dateOfLeaving ?? null, reason: v.fields.reasonForLeaving ?? null });
    }
    return c;
  });
  await audit(ctx, 'issue', 'certificate', row.id, { type: v.type, serialNo: row.serialNo });
  return row;
}

export async function listCertificates(ctx: Ctx, f: { studentId?: string; type?: string; limit?: number }) {
  requirePermission(ctx, 'certificates.view');
  if (f.studentId) await assertStudentAccess(ctx, f.studentId);
  return ctx.db
    .select({
      id: certificates.id,
      type: certificates.type,
      serialNo: certificates.serialNo,
      issuedAt: certificates.issuedAt,
      revokedAt: certificates.revokedAt,
      revokeReason: certificates.revokeReason,
      studentId: certificates.studentId,
      studentName: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
      admissionNo: students.admissionNo,
      issuedByName: users.fullName,
    })
    .from(certificates)
    .innerJoin(students, eq(students.id, certificates.studentId))
    .leftJoin(users, eq(users.id, certificates.issuedBy))
    .where(and(eq(certificates.schoolId, ctx.schoolId), f.studentId ? eq(certificates.studentId, f.studentId) : undefined, f.type ? eq(certificates.type, f.type) : undefined))
    .orderBy(desc(certificates.issuedAt))
    .limit(f.limit ?? 500);
}

export async function revokeCertificate(ctx: Ctx, id: string, reason: string) {
  requirePermission(ctx, 'certificates.delete');
  const [c] = await ctx.db
    .update(certificates)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(certificates.id, id), eq(certificates.schoolId, ctx.schoolId), sql`${certificates.revokedAt} is null`))
    .returning();
  must(c, 'Certificate');
  await audit(ctx, 'revoke', 'certificate', id, { reason });
  return c;
}

export const verifyUrl = (kind: 'certificate' | 'student' | 'staff', id: string) => `${publicUrl()}/verify/${kind}/${id}`;
const qrPng = (text: string) => QRCode.toBuffer(text, { margin: 1, width: 240, errorCorrectionLevel: 'M' });

// ── PDF: certificates ──

function certificateRows(type: CertType, d: Record<string, string | null>): [string, string][] {
  const base: [string, string][] = [
    ['Name of the student', d.name ?? '—'],
    ['Admission number', d.admissionNo ?? '—'],
    ["Father's name", d.father ?? '—'],
    ["Mother's name", d.mother ?? '—'],
  ];
  if (type === 'transfer')
    return [
      ...base,
      ['Nationality', d.nationality ?? '—'],
      ['Religion', d.religion ?? '—'],
      ['Date of birth (in figures)', fmt(d.dateOfBirth)],
      ['Date of birth (in words)', d.dateOfBirthWords ?? '—'],
      ['Date of first admission & class', `${fmt(d.admissionDate)}${d.firstClass ? `, ${d.firstClass}` : ''}`],
      ['Class in which last studied', d.lastClass ?? d.currentClass ?? '—'],
      ['Subjects studied', d.subjectsStudied ?? '—'],
      ['Whether qualified for promotion', d.qualifiedForPromotion ?? '—'],
      ['School dues paid up to', d.feesPaidUpTo || '—'],
      ['General conduct', d.conduct ?? '—'],
      ['Date of leaving the school', fmt(d.dateOfLeaving)],
      ['Reason for leaving', d.reasonForLeaving ?? '—'],
      ['Any other remarks', d.remarks || '—'],
    ];
  return base;
}

function bodyText(type: CertType, d: Record<string, string | null>, school: string) {
  const he = d.gender === 'female' ? 'She' : d.gender === 'male' ? 'He' : 'They';
  const his = d.gender === 'female' ? 'her' : d.gender === 'male' ? 'his' : 'their';
  const child = d.gender === 'female' ? 'daughter' : d.gender === 'male' ? 'son' : 'child';
  const parent = [d.father, d.mother].filter(Boolean).join(' and ') || d.guardian || '—';
  const who = `${d.name} (Admission No. ${d.admissionNo}), ${child} of ${parent}`;
  if (type === 'bonafide')
    return `This is to certify that ${who}, is a bonafide student of ${school}, studying in ${d.currentClass ?? '—'} during the academic year ${d.academicYear ?? '—'}. ${his[0].toUpperCase() + his.slice(1)} date of birth as per our records is ${fmt(d.dateOfBirth)}.\n\nThis certificate is issued on request for the purpose of ${d.purpose || 'official use'}.`;
  if (type === 'character')
    return `This is to certify that ${who}, has been a student of ${school}${d.currentClass ? `, last studying in ${d.currentClass}` : ''}. To the best of our knowledge, ${his} conduct and character have been ${(d.conduct || 'good').toLowerCase()}.${d.remarks ? `\n\n${d.remarks}` : ''}\n\nWe wish ${his === 'their' ? 'them' : his === 'her' ? 'her' : 'him'} success in all future endeavours.`;
  return `This is to certify that ${who}, studied in ${school} from ${fmt(d.studiedFrom)} to ${fmt(d.studiedTo)}${d.currentClass ? `, and was last enrolled in ${d.currentClass}` : ''}. ${he} bore a ${(d.conduct || 'good').toLowerCase()} character during this period.${d.purpose ? `\n\nIssued for the purpose of ${d.purpose}.` : ''}`;
}

async function drawCertificate(doc: Doc, h: SchoolHeader, c: typeof certificates.$inferSelect) {
  const type = c.type as CertType;
  const d = c.data;
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  // Decorative border
  doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).lineWidth(1.5).strokeColor(h.branding.primaryColor).stroke();
  doc.rect(25, 25, doc.page.width - 50, doc.page.height - 50).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
  let y = letterhead(doc, h, CERT_TYPES[type].title, null);
  doc.font('Helvetica').fontSize(9.5).fillColor('#334155');
  doc.text(`Certificate No.: ${c.serialNo}`, left, y, { width: width / 2 });
  doc.text(`Date of issue: ${c.issuedAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`, left + width / 2, y, { width: width / 2, align: 'right' });
  y += 26;
  if (type === 'transfer') {
    certificateRows(type, d).forEach(([k, v], i) => {
      const rowY = y;
      doc.font('Helvetica').fontSize(9.5).fillColor('#64748b').text(`${i + 1}.`, left, rowY, { width: 20 });
      doc.text(k, left + 20, rowY, { width: 190 });
      doc.font('Helvetica-Bold').fillColor('#0f172a').text(v, left + 215, rowY, { width: width - 215 });
      y = Math.max(doc.y, rowY + 14) + 6;
    });
  } else {
    doc.font('Helvetica').fontSize(12).fillColor('#0f172a').text(bodyText(type, d, h.name), left + 10, y + 10, { width: width - 20, align: 'justify', lineGap: 6 });
    y = doc.y + 20;
  }
  // QR for verification
  const qr = await qrPng(verifyUrl('certificate', c.id));
  const qrY = doc.page.height - 190;
  doc.image(qr, left, qrY, { width: 72 });
  doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text('Scan to verify this certificate', left, qrY + 76, { width: 110 });
  if (c.revokedAt) {
    doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font('Helvetica-Bold').fontSize(64).fillColor('#dc2626').opacity(0.18).text('REVOKED', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center' });
    doc.restore().opacity(1);
  }
  // Signatures
  const sigY = doc.page.height - 110;
  const labels = type === 'transfer' ? ['Class Teacher', 'Checked by', h.branding.principalName ? `Principal (${h.branding.principalName})` : 'Principal'] : ['', '', h.branding.principalName ? `Principal (${h.branding.principalName})` : 'Principal'];
  labels.forEach((label, i) => {
    if (!label) return;
    const x = left + 130 + (i * (width - 130)) / 3;
    const w = (width - 130) / 3;
    doc.moveTo(x + 8, sigY).lineTo(x + w - 8, sigY).lineWidth(0.6).strokeColor('#94a3b8').stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor('#334155').text(label, x, sigY + 4, { width: w, align: 'center' });
  });
  doc.font('Helvetica').fontSize(8).fillColor('#94a3b8').text('(School seal)', left + 130, sigY - 40, { width: 120 });
}

export async function certificatePdf(ctx: Ctx, id: string) {
  requirePermission(ctx, 'certificates.view');
  const [c] = await ctx.db.select().from(certificates).where(and(eq(certificates.id, id), eq(certificates.schoolId, ctx.schoolId)));
  must(c, 'Certificate');
  await assertStudentAccess(ctx, c.studentId);
  const h = await loadSchoolHeader(ctx.schoolId);
  const doc = createDoc();
  await drawCertificate(doc, h, c);
  footer(doc, h, `${CERT_TYPES[c.type as CertType].title} · ${c.serialNo} · scan the QR code to verify`);
  return { buffer: await toBuffer(doc), filename: `${CERT_TYPES[c.type as CertType].short}-${c.serialNo.replace(/\//g, '-')}.pdf` };
}

// ── PDF: ID cards (CR80, 10 per A4 sheet) ──

const MM = 72 / 25.4;
const CARD_W = 85.6 * MM;
const CARD_H = 54 * MM;

interface CardData {
  id: string;
  kind: 'student' | 'staff';
  name: string;
  photo: Buffer | null;
  lines: [string, string][];
  badge: string;
}

async function drawCard(doc: Doc, h: SchoolHeader, x: number, y: number, c: CardData, validTill: string) {
  const color = h.branding.primaryColor;
  doc.save();
  doc.roundedRect(x, y, CARD_W, CARD_H, 8).lineWidth(0.5).strokeColor('#cbd5e1').stroke();
  doc.roundedRect(x, y, CARD_W, 34, 8).fill(color);
  doc.rect(x, y + 26, CARD_W, 8).fill(color);
  let tx = x + 8;
  if (h.logo) {
    try {
      doc.image(h.logo, x + 7, y + 5, { fit: [24, 24] });
      tx = x + 36;
    } catch {
      /* skip unsupported logo */
    }
  }
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff').text(h.name, tx, y + 7, { width: CARD_W - (tx - x) - 8, lineBreak: false, ellipsis: true });
  doc.font('Helvetica').fontSize(6.5).fillColor('#ffffff').text(c.badge, tx, y + 19, { width: CARD_W - (tx - x) - 8, lineBreak: false });
  // Photo
  const px = x + 8;
  const py = y + 40;
  const pw = 58;
  const ph = 74;
  doc.roundedRect(px, py, pw, ph, 4).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  if (c.photo) {
    try {
      doc.image(c.photo, px + 1, py + 1, { cover: [pw - 2, ph - 2], align: 'center', valign: 'center' });
    } catch {
      /* unsupported photo */
    }
  } else {
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#94a3b8').text(c.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join(''), px, py + ph / 2 - 10, { width: pw, align: 'center' });
  }
  // Details
  const dx = px + pw + 8;
  const dw = CARD_W - (dx - x) - 52;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0f172a').text(c.name, dx, py, { width: dw + 44, lineBreak: false, ellipsis: true });
  let ly = py + 14;
  for (const [k, v] of c.lines) {
    doc.font('Helvetica').fontSize(6.8).fillColor('#64748b').text(k, dx, ly, { width: 42, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(7.2).fillColor('#0f172a').text(v || '—', dx + 42, ly - 0.5, { width: dw - 42 + 2, lineBreak: false, ellipsis: true });
    ly += 11.5;
  }
  const qr = await qrPng(verifyUrl(c.kind, c.id));
  doc.image(qr, x + CARD_W - 52, py + 16, { width: 46 });
  doc.font('Helvetica').fontSize(5.5).fillColor('#64748b').text(`Valid till ${validTill}`, x + 8, y + CARD_H - 11, { width: CARD_W - 16, align: 'left', lineBreak: false });
  if (h.branding.phone) doc.text(h.branding.phone, x + 8, y + CARD_H - 11, { width: CARD_W - 16, align: 'right', lineBreak: false });
  doc.restore();
}

async function cardSheet(ctx: Ctx, cards: CardData[], validTill: string, filename: string) {
  if (!cards.length) throw badRequest('No one to print cards for');
  const h = await loadSchoolHeader(ctx.schoolId);
  // No page margins: five rows of CR80 cards only just fit on A4.
  const doc = createDoc({ margin: 0 });
  const gapX = 18;
  const gapY = 6;
  const left = (doc.page.width - 2 * CARD_W - gapX) / 2;
  const top = (doc.page.height - 5 * CARD_H - 4 * gapY) / 2;
  for (const [i, c] of cards.entries()) {
    const slot = i % 10;
    if (i > 0 && slot === 0) doc.addPage();
    await drawCard(doc, h, left + (slot % 2) * (CARD_W + gapX), top + Math.floor(slot / 2) * (CARD_H + gapY), c, validTill);
  }
  return { buffer: await toBuffer(doc), filename };
}

export async function studentIdCards(ctx: Ctx, f: { sectionId?: string; studentIds?: string[] }) {
  requirePermission(ctx, 'certificates.view');
  const [year] = await ctx.db.select().from(academicYears).where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)));
  if (!year) throw badRequest('Set a current academic year first');
  const rows = await ctx.db
    .select({ s: students, className: classes.name, sectionName: sections.name, rollNo: enrollments.rollNo })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .innerJoin(sections, eq(sections.id, enrollments.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(
      and(
        eq(enrollments.schoolId, ctx.schoolId),
        eq(enrollments.academicYearId, year.id),
        eq(students.status, 'active'),
        f.sectionId ? eq(enrollments.sectionId, f.sectionId) : undefined,
        f.studentIds?.length ? inArray(students.id, f.studentIds) : undefined,
      ),
    )
    .orderBy(asc(classes.level), asc(sections.name), asc(enrollments.rollNo));
  const phones = new Map<string, string>();
  if (rows.length) {
    const g = await ctx.db
      .select({ studentId: studentGuardians.studentId, phone: guardians.phone, primary: studentGuardians.isPrimary })
      .from(studentGuardians)
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .where(inArray(studentGuardians.studentId, rows.map((r) => r.s.id)))
      .orderBy(desc(studentGuardians.isPrimary));
    for (const x of g) if (x.phone && !phones.has(x.studentId)) phones.set(x.studentId, x.phone);
  }
  const cards: CardData[] = [];
  for (const r of rows) {
    cards.push({
      id: r.s.id,
      kind: 'student',
      name: `${r.s.firstName} ${r.s.lastName}`.trim(),
      photo: await loadImage(r.s.photoUrl),
      badge: `STUDENT ID · ${year.name}`,
      lines: [
        ['Class', `${r.className} - ${r.sectionName}`],
        ['Roll / Adm.', `${r.rollNo ?? '—'} / ${r.s.admissionNo}`],
        ['DOB', fmt(r.s.dateOfBirth)],
        ['Blood grp', r.s.bloodGroup ?? ''],
        ['Parent ph.', phones.get(r.s.id) ?? r.s.phone ?? ''],
      ],
    });
  }
  return cardSheet(ctx, cards, fmt(year.endDate), `id-cards-students.pdf`);
}

export async function staffIdCards(ctx: Ctx, userIds?: string[]) {
  requirePermission(ctx, 'certificates.view');
  requirePermission(ctx, 'staff.view');
  const rows = await ctx.db
    .select({ u: users, p: staffProfiles, roleName: roles.name })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
    .where(and(eq(users.schoolId, ctx.schoolId), eq(users.isActive, true), sql`${roles.key} not in ('student','parent')`, userIds?.length ? inArray(users.id, userIds) : undefined))
    .orderBy(asc(users.fullName));
  const cards: CardData[] = [];
  for (const r of rows) {
    cards.push({
      id: r.u.id,
      kind: 'staff',
      name: r.u.fullName,
      photo: await loadImage(r.u.avatarUrl),
      badge: 'STAFF ID',
      lines: [
        ['Role', r.p?.designation ?? r.roleName],
        ['Emp. code', r.p?.employeeCode ?? ''],
        ['Department', r.p?.department ?? ''],
        ['Phone', r.u.phone ?? ''],
        ['Joined', fmt(r.p?.joinDate)],
      ],
    });
  }
  const end = new Date();
  end.setFullYear(end.getFullYear() + 1);
  return cardSheet(ctx, cards, fmt(end.toISOString().slice(0, 10)), 'id-cards-staff.pdf');
}
