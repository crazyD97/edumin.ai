/**
 * Fee management.
 *
 * Fee structures describe what is charged (per class or per student, per
 * frequency). "Generate invoices" materialises them into one invoice per
 * student per installment — idempotently, thanks to a unique key on
 * (student, structure, period). Payments are allocated to invoices oldest-first
 * unless specific invoices are chosen, which supports partial payments.
 */
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { CONCESSION_KINDS, FEE_FREQUENCIES, PAYMENT_METHODS, type FeeFrequency } from '@edumin/shared';
import {
  academicYears,
  classes,
  enrollments,
  feeConcessions,
  feeHeads,
  feeInvoices,
  feeStructures,
  paymentAllocations,
  payments,
  schools,
  sections,
  students,
  users,
} from '../../db/schema';
import { assertStudentAccess, requirePermission, scopedStudentIds, withTx, type Ctx } from '../../core/context';
import { badRequest, must } from '../../core/errors';
import { nextNumber } from '../../core/sequence';
import { audit } from '../../core/audit';
import { audience, notifyFamilies, notifyUsers } from '../../core/notify';
import { resolveYearId } from '../academics/routes';
import { createDoc, fmtMoney, footer, infoGrid, letterhead, loadSchoolHeader, table, toBuffer } from '../../core/pdf';
import { availableGateway, createCheckout, schoolRazorpay } from './gateway';
import { signLink } from '../../core/crypto';
import { verifyPaymentSignature } from '../../core/razorpay';
import { publicUrl } from '../../core/env';

/** Amount still owed on an invoice. */
export const BALANCE = sql<number>`(${feeInvoices.amount} - ${feeInvoices.discount} - ${feeInvoices.scholarship} + ${feeInvoices.lateFee} - ${feeInvoices.paid})`;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Heads ──
export const headInput = z.object({ name: z.string().trim().min(2).max(100), description: z.string().trim().nullish() });

export async function listHeads(ctx: Ctx) {
  return ctx.db.select().from(feeHeads).where(eq(feeHeads.schoolId, ctx.schoolId)).orderBy(asc(feeHeads.name));
}

// ── Structures ──
export const structureInput = z
  .object({
    academicYearId: z.uuid().optional(),
    feeHeadId: z.uuid(),
    classId: z.uuid().nullish(),
    studentId: z.uuid().nullish(),
    name: z.string().trim().min(2).max(150),
    amount: z.coerce.number().positive(),
    frequency: z.enum(FEE_FREQUENCIES),
    dueDay: z.coerce.number().int().min(1).max(28).default(10),
    lateFeeAmount: z.coerce.number().min(0).default(0),
    isActive: z.boolean().default(true),
  })
  .refine((v) => !!v.classId !== !!v.studentId, { message: 'Choose either a class or a single student', path: ['classId'] });

export async function listStructures(ctx: Ctx, yearId?: string) {
  const y = await resolveYearId(ctx, yearId);
  return ctx.db
    .select({
      structure: feeStructures,
      headName: feeHeads.name,
      className: classes.name,
      studentName: sql<string | null>`${students.firstName} || ' ' || ${students.lastName}`,
      invoiceCount: sql<number>`(select count(*)::int from ${feeInvoices} where ${feeInvoices.feeStructureId} = ${feeStructures.id})`,
    })
    .from(feeStructures)
    .innerJoin(feeHeads, eq(feeHeads.id, feeStructures.feeHeadId))
    .leftJoin(classes, eq(classes.id, feeStructures.classId))
    .leftJoin(students, eq(students.id, feeStructures.studentId))
    .where(and(eq(feeStructures.schoolId, ctx.schoolId), eq(feeStructures.academicYearId, y)))
    .orderBy(asc(classes.level), asc(feeHeads.name))
    .then((rows) => rows.map((r) => ({ ...r.structure, headName: r.headName, className: r.className, studentName: r.studentName, invoiceCount: r.invoiceCount })));
}

async function validateStructureRefs(ctx: Ctx, v: z.infer<typeof structureInput>) {
  must((await ctx.db.select({ id: feeHeads.id }).from(feeHeads).where(and(eq(feeHeads.id, v.feeHeadId), eq(feeHeads.schoolId, ctx.schoolId))))[0], 'Fee head');
  if (v.classId) must((await ctx.db.select({ id: classes.id }).from(classes).where(and(eq(classes.id, v.classId), eq(classes.schoolId, ctx.schoolId))))[0], 'Class');
  if (v.studentId) must((await ctx.db.select({ id: students.id }).from(students).where(and(eq(students.id, v.studentId), eq(students.schoolId, ctx.schoolId))))[0], 'Student');
}

export async function createStructure(ctx: Ctx, v: z.infer<typeof structureInput>) {
  requirePermission(ctx, 'fees.create');
  await validateStructureRefs(ctx, v);
  const academicYearId = await resolveYearId(ctx, v.academicYearId);
  const [row] = await ctx.db.insert(feeStructures).values({ ...v, academicYearId, schoolId: ctx.schoolId }).returning();
  await audit(ctx, 'create', 'fee_structure', row.id);
  return row;
}

export async function updateStructure(ctx: Ctx, id: string, v: z.infer<typeof structureInput>) {
  requirePermission(ctx, 'fees.edit');
  await validateStructureRefs(ctx, v);
  const { academicYearId: _ignored, ...rest } = v;
  const [row] = await ctx.db.update(feeStructures).set(rest).where(and(eq(feeStructures.id, id), eq(feeStructures.schoolId, ctx.schoolId))).returning();
  return must(row, 'Fee structure');
}

// ── Concessions ──
export const concessionInput = z.object({
  studentId: z.uuid(),
  academicYearId: z.uuid().optional(),
  feeHeadId: z.uuid().nullish(),
  kind: z.enum(CONCESSION_KINDS),
  valueType: z.enum(['percent', 'fixed']),
  value: z.coerce.number().positive(),
  reason: z.string().trim().nullish(),
});

export async function listConcessions(ctx: Ctx, f: { studentId?: string; academicYearId?: string }) {
  const y = await resolveYearId(ctx, f.academicYearId);
  return ctx.db
    .select({
      c: feeConcessions,
      headName: feeHeads.name,
      studentName: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
      admissionNo: students.admissionNo,
    })
    .from(feeConcessions)
    .innerJoin(students, eq(students.id, feeConcessions.studentId))
    .leftJoin(feeHeads, eq(feeHeads.id, feeConcessions.feeHeadId))
    .where(and(eq(feeConcessions.schoolId, ctx.schoolId), eq(feeConcessions.academicYearId, y), f.studentId ? eq(feeConcessions.studentId, f.studentId) : undefined))
    .orderBy(desc(feeConcessions.createdAt))
    .then((rows) => rows.map((r) => ({ ...r.c, headName: r.headName, studentName: r.studentName, admissionNo: r.admissionNo })));
}

export async function createConcession(ctx: Ctx, v: z.infer<typeof concessionInput>) {
  requirePermission(ctx, 'fees.approve');
  if (v.valueType === 'percent' && v.value > 100) throw badRequest('Percentage cannot exceed 100');
  must((await ctx.db.select({ id: students.id }).from(students).where(and(eq(students.id, v.studentId), eq(students.schoolId, ctx.schoolId))))[0], 'Student');
  const academicYearId = await resolveYearId(ctx, v.academicYearId);
  const [row] = await ctx.db.insert(feeConcessions).values({ ...v, academicYearId, schoolId: ctx.schoolId, createdBy: ctx.userId }).returning();
  // Re-apply to the student's unpaid invoices so the change is visible immediately.
  await recalcConcessions(ctx, v.studentId, academicYearId);
  await audit(ctx, 'create', 'fee_concession', row.id, v);
  return row;
}

export async function deleteConcession(ctx: Ctx, id: string) {
  requirePermission(ctx, 'fees.approve');
  const [row] = await ctx.db.delete(feeConcessions).where(and(eq(feeConcessions.id, id), eq(feeConcessions.schoolId, ctx.schoolId))).returning();
  must(row, 'Concession');
  await recalcConcessions(ctx, row.studentId, row.academicYearId);
}

type Concession = typeof feeConcessions.$inferSelect;

function concessionAmounts(amount: number, headId: string | null, list: Concession[]) {
  let discount = 0;
  let scholarship = 0;
  for (const c of list) {
    if (c.feeHeadId && c.feeHeadId !== headId) continue;
    const v = c.valueType === 'percent' ? (amount * c.value) / 100 : c.value;
    if (c.kind === 'scholarship') scholarship += v;
    else discount += v;
  }
  // Never discount below zero.
  const total = discount + scholarship;
  if (total > amount) {
    const f = amount / total;
    discount *= f;
    scholarship *= f;
  }
  return { discount: round2(discount), scholarship: round2(scholarship) };
}

async function recalcConcessions(ctx: Ctx, studentId: string, academicYearId: string) {
  const list = await ctx.db.select().from(feeConcessions).where(and(eq(feeConcessions.studentId, studentId), eq(feeConcessions.academicYearId, academicYearId)));
  const invs = await ctx.db
    .select()
    .from(feeInvoices)
    .where(and(eq(feeInvoices.studentId, studentId), eq(feeInvoices.academicYearId, academicYearId), eq(feeInvoices.paid, 0), eq(feeInvoices.status, 'unpaid')));
  for (const inv of invs) {
    const c = concessionAmounts(inv.amount, inv.feeHeadId, list);
    await ctx.db.update(feeInvoices).set(c).where(eq(feeInvoices.id, inv.id));
  }
}

// ── Invoice generation ──

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Installment schedule for a frequency within an academic year. */
export function installments(freq: FeeFrequency, yearStart: string, dueDay: number) {
  const start = new Date(yearStart + 'T00:00:00Z');
  const at = (offset: number) => {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, dueDay));
    return { date: d.toISOString().slice(0, 10), label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, key: d.toISOString().slice(0, 7) };
  };
  switch (freq) {
    case 'monthly':
      return Array.from({ length: 12 }, (_, i) => ({ period: at(i).key, label: at(i).label, dueDate: at(i).date }));
    case 'quarterly':
      return [0, 3, 6, 9].map((m, i) => ({ period: `Q${i + 1}`, label: `Quarter ${i + 1}`, dueDate: at(m).date }));
    case 'annual':
      return [{ period: 'annual', label: 'Annual', dueDate: at(0).date }];
    default:
      return [{ period: 'once', label: '', dueDate: at(0).date }];
  }
}

export async function generateInvoices(ctx: Ctx, f: { academicYearId?: string; structureId?: string; classId?: string; upToDate?: string | null }) {
  requirePermission(ctx, 'fees.create');
  const yearId = await resolveYearId(ctx, f.academicYearId);
  const [year] = await ctx.db.select().from(academicYears).where(eq(academicYears.id, yearId));
  const structs = await ctx.db
    .select()
    .from(feeStructures)
    .where(
      and(
        eq(feeStructures.schoolId, ctx.schoolId),
        eq(feeStructures.academicYearId, yearId),
        eq(feeStructures.isActive, true),
        f.structureId ? eq(feeStructures.id, f.structureId) : undefined,
        f.classId ? or(eq(feeStructures.classId, f.classId), isNull(feeStructures.classId)) : undefined,
      ),
    );
  const concessions = await ctx.db.select().from(feeConcessions).where(and(eq(feeConcessions.schoolId, ctx.schoolId), eq(feeConcessions.academicYearId, yearId)));
  const byStudent = new Map<string, Concession[]>();
  for (const c of concessions) byStudent.set(c.studentId, [...(byStudent.get(c.studentId) ?? []), c]);

  let created = 0;
  await ctx.db.transaction(async (tx) => {
    for (const s of structs) {
      let studentIds: string[];
      if (s.studentId) studentIds = [s.studentId];
      else {
        const rows = await tx
          .select({ id: enrollments.studentId })
          .from(enrollments)
          .innerJoin(sections, eq(sections.id, enrollments.sectionId))
          .innerJoin(students, eq(students.id, enrollments.studentId))
          .where(and(eq(enrollments.academicYearId, yearId), eq(sections.classId, s.classId!), eq(enrollments.status, 'active'), eq(students.status, 'active')));
        studentIds = rows.map((r) => r.id);
      }
      const plan = installments(s.frequency as FeeFrequency, year.startDate, s.dueDay).filter((p) => !f.upToDate || p.dueDate <= f.upToDate);
      const values = studentIds.flatMap((sid) =>
        plan.map((p) => ({
          schoolId: ctx.schoolId,
          studentId: sid,
          academicYearId: yearId,
          feeStructureId: s.id,
          feeHeadId: s.feeHeadId,
          title: p.label ? `${s.name} – ${p.label}` : s.name,
          period: p.period,
          dueDate: p.dueDate,
          amount: s.amount,
          ...concessionAmounts(s.amount, s.feeHeadId, byStudent.get(sid) ?? []),
        })),
      );
      for (let i = 0; i < values.length; i += 500) {
        const res = await tx.insert(feeInvoices).values(values.slice(i, i + 500)).onConflictDoNothing().returning({ id: feeInvoices.id });
        created += res.length;
      }
    }
  });
  await audit(ctx, 'generate', 'fee_invoices', null, { created, yearId });
  return { created, structures: structs.length };
}

/** Adds the structure's late fee to overdue invoices that don't have one yet. */
export async function applyLateFees(ctx: Ctx, asOf = new Date().toISOString().slice(0, 10)) {
  requirePermission(ctx, 'fees.edit');
  const res = await ctx.db.execute(sql`
    update fee_invoices i set late_fee = fs.late_fee_amount, updated_at = now()
    from fee_structures fs
    where i.fee_structure_id = fs.id and i.school_id = ${ctx.schoolId}
      and i.status in ('unpaid','partial') and i.due_date < ${asOf}
      and i.late_fee = 0 and fs.late_fee_amount > 0
    returning i.id`);
  await audit(ctx, 'apply_late_fees', 'fee_invoices', null, { count: res.length });
  return { updated: res.length };
}

// ── Ledger & invoices ──

export const invoiceListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
  search: z.string().optional(),
  status: z.enum(['unpaid', 'partial', 'paid', 'cancelled', 'outstanding', 'overdue']).optional(),
  classId: z.uuid().optional(),
  sectionId: z.uuid().optional(),
  studentId: z.uuid().optional(),
  academicYearId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export async function listInvoices(ctx: Ctx, q: z.infer<typeof invoiceListQuery>) {
  requirePermission(ctx, 'fees.view');
  const yearId = await resolveYearId(ctx, q.academicYearId);
  const scoped = await scopedStudentIds(ctx);
  const today = new Date().toISOString().slice(0, 10);
  const where = and(
    eq(feeInvoices.schoolId, ctx.schoolId),
    eq(feeInvoices.academicYearId, yearId),
    scoped ? inArray(feeInvoices.studentId, scoped.length ? scoped : ['00000000-0000-0000-0000-000000000000']) : undefined,
    q.studentId ? eq(feeInvoices.studentId, q.studentId) : undefined,
    q.status === 'outstanding'
      ? inArray(feeInvoices.status, ['unpaid', 'partial'])
      : q.status === 'overdue'
        ? and(inArray(feeInvoices.status, ['unpaid', 'partial']), lt(feeInvoices.dueDate, today))
        : q.status
          ? eq(feeInvoices.status, q.status)
          : undefined,
    q.classId ? eq(sections.classId, q.classId) : undefined,
    q.sectionId ? eq(enrollments.sectionId, q.sectionId) : undefined,
    q.from ? gte(feeInvoices.dueDate, q.from) : undefined,
    q.to ? lte(feeInvoices.dueDate, q.to) : undefined,
    q.search ? or(sql`(${students.firstName} || ' ' || ${students.lastName}) ilike ${'%' + q.search + '%'}`, sql`${students.admissionNo} ilike ${'%' + q.search + '%'}`) : undefined,
  );
  const base = ctx.db
    .select({
      invoice: feeInvoices,
      balance: BALANCE,
      studentName: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
      admissionNo: students.admissionNo,
      className: classes.name,
      sectionName: sections.name,
    })
    .from(feeInvoices)
    .innerJoin(students, eq(students.id, feeInvoices.studentId))
    .leftJoin(enrollments, and(eq(enrollments.studentId, students.id), eq(enrollments.academicYearId, feeInvoices.academicYearId)))
    .leftJoin(sections, eq(sections.id, enrollments.sectionId))
    .leftJoin(classes, eq(classes.id, sections.classId))
    .where(where);
  const rows = await base.orderBy(asc(feeInvoices.dueDate), asc(students.firstName)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  const [agg] = await ctx.db
    .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${BALANCE}),0)::float` })
    .from(feeInvoices)
    .innerJoin(students, eq(students.id, feeInvoices.studentId))
    .leftJoin(enrollments, and(eq(enrollments.studentId, students.id), eq(enrollments.academicYearId, feeInvoices.academicYearId)))
    .leftJoin(sections, eq(sections.id, enrollments.sectionId))
    .where(where);
  return {
    rows: rows.map((r) => ({ ...r.invoice, balance: round2(Number(r.balance)), studentName: r.studentName, admissionNo: r.admissionNo, className: r.className, sectionName: r.sectionName })),
    total: agg.n,
    balanceTotal: agg.total,
  };
}

export async function studentLedger(ctx: Ctx, studentId: string, academicYearId?: string) {
  requirePermission(ctx, 'fees.view');
  await assertStudentAccess(ctx, studentId);
  const [student] = await ctx.db
    .select({ id: students.id, name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, admissionNo: students.admissionNo })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.schoolId, ctx.schoolId)));
  must(student, 'Student');
  const yearId = await resolveYearId(ctx, academicYearId);
  const invoices = await ctx.db
    .select({ invoice: feeInvoices, balance: BALANCE, headName: feeHeads.name })
    .from(feeInvoices)
    .leftJoin(feeHeads, eq(feeHeads.id, feeInvoices.feeHeadId))
    .where(and(eq(feeInvoices.studentId, studentId), eq(feeInvoices.academicYearId, yearId)))
    .orderBy(asc(feeInvoices.dueDate));
  const pays = await ctx.db
    .select({ payment: payments, receivedByName: users.fullName })
    .from(payments)
    .leftJoin(users, eq(users.id, payments.receivedBy))
    .where(and(eq(payments.studentId, studentId), eq(payments.schoolId, ctx.schoolId)))
    .orderBy(desc(payments.paidAt));
  const inv = invoices.filter((i) => i.invoice.status !== 'cancelled');
  const sum = (fn: (i: (typeof inv)[number]) => number) => round2(inv.reduce((a, i) => a + fn(i), 0));
  const today = new Date().toISOString().slice(0, 10);
  return {
    student,
    invoices: invoices.map((i) => ({ ...i.invoice, balance: round2(Number(i.balance)), headName: i.headName })),
    payments: pays.map((p) => ({ ...p.payment, receivedByName: p.receivedByName })),
    summary: {
      gross: sum((i) => i.invoice.amount),
      concessions: sum((i) => i.invoice.discount + i.invoice.scholarship),
      lateFees: sum((i) => i.invoice.lateFee),
      paid: sum((i) => i.invoice.paid),
      balance: sum((i) => Number(i.balance)),
      overdue: sum((i) => (i.invoice.dueDate < today ? Number(i.balance) : 0)),
    },
  };
}

export async function cancelInvoice(ctx: Ctx, id: string) {
  requirePermission(ctx, 'fees.delete');
  const [inv] = await ctx.db.select().from(feeInvoices).where(and(eq(feeInvoices.id, id), eq(feeInvoices.schoolId, ctx.schoolId)));
  must(inv, 'Invoice');
  if (inv.paid > 0) throw badRequest('This invoice has payments against it and cannot be cancelled');
  await ctx.db.update(feeInvoices).set({ status: 'cancelled' }).where(eq(feeInvoices.id, id));
  await audit(ctx, 'cancel', 'fee_invoice', id);
}

export const adjustInput = z.object({ discount: z.coerce.number().min(0).optional(), lateFee: z.coerce.number().min(0).optional(), amount: z.coerce.number().positive().optional() });

export async function adjustInvoice(ctx: Ctx, id: string, v: z.infer<typeof adjustInput>) {
  requirePermission(ctx, 'fees.approve');
  const [inv] = await ctx.db.select().from(feeInvoices).where(and(eq(feeInvoices.id, id), eq(feeInvoices.schoolId, ctx.schoolId)));
  must(inv, 'Invoice');
  const next = { ...inv, ...v };
  const net = round2(next.amount - next.discount - next.scholarship + next.lateFee);
  if (net < inv.paid) throw badRequest('Adjusted total is below what has already been paid');
  const status = inv.paid === 0 ? 'unpaid' : inv.paid >= net ? 'paid' : 'partial';
  const [row] = await ctx.db.update(feeInvoices).set({ ...v, status }).where(eq(feeInvoices.id, id)).returning();
  await audit(ctx, 'adjust', 'fee_invoice', id, v);
  return row;
}

// ── Payments ──

export const paymentInput = z.object({
  studentId: z.uuid(),
  amount: z.coerce.number().positive(),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(100).nullish(),
  paidAt: z.iso.date().nullish(),
  notes: z.string().trim().max(500).nullish(),
  /** Optional explicit allocation; otherwise oldest dues are settled first. */
  invoiceIds: z.array(z.uuid()).optional(),
});

/** Allocates `amount` across outstanding invoices; returns allocations. */
async function allocate(ctx: Ctx, paymentId: string, studentId: string, amount: number, invoiceIds?: string[]) {
  const open = await ctx.db
    .select({ id: feeInvoices.id, balance: BALANCE, paid: feeInvoices.paid, net: sql<number>`(${feeInvoices.amount} - ${feeInvoices.discount} - ${feeInvoices.scholarship} + ${feeInvoices.lateFee})` })
    .from(feeInvoices)
    .where(and(eq(feeInvoices.studentId, studentId), eq(feeInvoices.schoolId, ctx.schoolId), inArray(feeInvoices.status, ['unpaid', 'partial']), invoiceIds?.length ? inArray(feeInvoices.id, invoiceIds) : undefined))
    .orderBy(asc(feeInvoices.dueDate))
    .for('update');
  const outstanding = round2(open.reduce((a, i) => a + Number(i.balance), 0));
  if (amount > outstanding + 0.001) throw badRequest(`Amount exceeds the outstanding balance of ${outstanding.toFixed(2)}`);
  let left = amount;
  const allocations: { invoiceId: string; amount: number }[] = [];
  for (const inv of open) {
    if (left <= 0) break;
    const take = round2(Math.min(left, Number(inv.balance)));
    if (take <= 0) continue;
    const paid = round2(inv.paid + take);
    await ctx.db
      .update(feeInvoices)
      .set({ paid, status: paid >= round2(Number(inv.net)) ? 'paid' : 'partial' })
      .where(eq(feeInvoices.id, inv.id));
    await ctx.db.insert(paymentAllocations).values({ paymentId, invoiceId: inv.id, amount: take });
    allocations.push({ invoiceId: inv.id, amount: take });
    left = round2(left - take);
  }
  return allocations;
}

export async function recordPayment(ctx: Ctx, v: z.infer<typeof paymentInput>, opts: { status?: 'completed' | 'pending'; gateway?: string } = {}) {
  requirePermission(ctx, opts.status === 'pending' ? 'fees.view' : 'fees.create');
  await assertStudentAccess(ctx, v.studentId);
  const [school] = await ctx.db.select({ settings: schools.settings }).from(schools).where(eq(schools.id, ctx.schoolId));
  const result = await ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    const receiptNo = await nextNumber(tx, ctx.schoolId, 'receipt', school.settings.receiptNoFormat);
    const [p] = await tx
      .insert(payments)
      .values({
        schoolId: ctx.schoolId,
        studentId: v.studentId,
        receiptNo,
        amount: v.amount,
        method: v.method,
        reference: v.reference,
        notes: v.notes,
        paidAt: v.paidAt ? new Date(v.paidAt + 'T12:00:00') : new Date(),
        receivedBy: opts.status === 'pending' ? null : ctx.userId,
        status: opts.status ?? 'completed',
        gateway: opts.gateway ?? null,
      })
      .returning();
    const allocations = opts.status === 'pending' ? [] : await allocate(t, p.id, v.studentId, v.amount, v.invoiceIds);
    return { payment: p, allocations };
  });
  if (result.payment.status === 'completed') await afterPayment(ctx, result.payment);
  return result;
}

async function afterPayment(ctx: Ctx, p: typeof payments.$inferSelect) {
  await audit(ctx, 'payment', 'payment', p.id, { amount: p.amount, method: p.method });
  await notifyFamilies(ctx.db, ctx.schoolId, [p.studentId], {
    type: 'fee_payment',
    title: `Payment received: ${p.receiptNo}`,
    body: `Amount ${p.amount.toFixed(2)} via ${p.method}`,
    link: '/fees',
    event: 'fee_receipt',
    vars: { amount: fmtMoney(p.amount), receipt: p.receiptNo },
    attachment: () => ({ kind: 'receipt', ref: { paymentId: p.id }, filename: `receipt-${p.receiptNo}.pdf` }),
    who: { parents: true },
    createdBy: ctx.userId,
  });
}

/** Online payments: create a pending payment and hand off to the gateway. */
export async function initiateOnlinePayment(ctx: Ctx, v: { studentId: string; amount: number; invoiceIds?: string[] }) {
  if (!ctx.features.has('online_payments')) throw badRequest('Online payments are not enabled for this school');
  const gateway = await availableGateway(ctx.db, ctx.schoolId);
  if (!gateway) throw badRequest('Online payment is not set up for this school yet. Please pay at the school office.');
  const { payment } = await recordPayment(ctx, { ...v, method: 'online' }, { status: 'pending', gateway });
  const [s] = await ctx.db.select({ name: sql<string>`${students.firstName} || ' ' || ${students.lastName}` }).from(students).where(eq(students.id, v.studentId));
  const checkout = await createCheckout(ctx.db, ctx.schoolId, { paymentId: payment.id, amount: payment.amount, receiptNo: payment.receiptNo, studentName: s?.name ?? '' });
  await ctx.db.update(payments).set({ gatewayRef: checkout.reference, notes: JSON.stringify({ invoiceIds: v.invoiceIds ?? [] }) }).where(eq(payments.id, payment.id));
  return { paymentId: payment.id, receiptNo: payment.receiptNo, amount: payment.amount, ...checkout };
}

/** Razorpay checkout callback: check the signature against the school's own secret, then settle. */
export async function verifyOnlinePayment(ctx: Ctx, paymentId: string, r: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) {
  const keys = await schoolRazorpay(ctx.db, ctx.schoolId);
  if (!keys) throw badRequest('Razorpay is not connected');
  const [p] = await ctx.db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.schoolId, ctx.schoolId)));
  must(p, 'Payment');
  if (p.gatewayRef !== r.razorpay_order_id || !verifyPaymentSignature(keys.keySecret, r.razorpay_order_id, r.razorpay_payment_id, r.razorpay_signature)) {
    throw badRequest('Payment verification failed');
  }
  await ctx.db.update(payments).set({ reference: r.razorpay_payment_id }).where(eq(payments.id, p.id));
  return confirmOnlinePayment(ctx, p.id, true);
}

/** A login-free link parents can open from WhatsApp/SMS to pay outstanding fees. */
export function payLink(studentId: string) {
  const { exp, sig } = signLink(`pay:${studentId}`, 30 * 86400);
  return `${publicUrl()}/pay/${studentId}?exp=${exp}&sig=${sig}`;
}

/** Called from the gateway webhook (or the mock confirm endpoint) once payment succeeds. */
export async function confirmOnlinePayment(ctx: Ctx, paymentId: string, success: boolean) {
  const [p] = await ctx.db.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.schoolId, ctx.schoolId)));
  must(p, 'Payment');
  if (p.status !== 'pending') return p;
  if (!success) {
    const [row] = await ctx.db.update(payments).set({ status: 'failed' }).where(eq(payments.id, p.id)).returning();
    return row;
  }
  const invoiceIds = (() => {
    try {
      return JSON.parse(p.notes ?? '{}').invoiceIds as string[];
    } catch {
      return undefined;
    }
  })();
  const row = await ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    await allocate(t, p.id, p.studentId, p.amount, invoiceIds?.length ? invoiceIds : undefined);
    const [r] = await tx.update(payments).set({ status: 'completed', paidAt: new Date(), notes: null }).where(eq(payments.id, p.id)).returning();
    return r;
  });
  await afterPayment(ctx, row);
  return row;
}

export async function listPayments(ctx: Ctx, q: { page: number; pageSize: number; from?: string; to?: string; method?: string; search?: string; studentId?: string }) {
  requirePermission(ctx, 'fees.view');
  const scoped = await scopedStudentIds(ctx);
  const where = and(
    eq(payments.schoolId, ctx.schoolId),
    scoped ? inArray(payments.studentId, scoped.length ? scoped : ['00000000-0000-0000-0000-000000000000']) : undefined,
    q.studentId ? eq(payments.studentId, q.studentId) : undefined,
    q.from ? gte(payments.paidAt, new Date(q.from + 'T00:00:00')) : undefined,
    q.to ? lte(payments.paidAt, new Date(q.to + 'T23:59:59.999')) : undefined,
    q.method ? eq(payments.method, q.method) : undefined,
    q.search
      ? or(sql`${payments.receiptNo} ilike ${'%' + q.search + '%'}`, sql`(${students.firstName} || ' ' || ${students.lastName}) ilike ${'%' + q.search + '%'}`, sql`${students.admissionNo} ilike ${'%' + q.search + '%'}`)
      : undefined,
  );
  const rows = await ctx.db
    .select({ payment: payments, studentName: sql<string>`${students.firstName} || ' ' || ${students.lastName}`, admissionNo: students.admissionNo, receivedByName: users.fullName })
    .from(payments)
    .innerJoin(students, eq(students.id, payments.studentId))
    .leftJoin(users, eq(users.id, payments.receivedBy))
    .where(where)
    .orderBy(desc(payments.paidAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [agg] = await ctx.db
    .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${payments.amount}) filter (where ${payments.status} = 'completed'),0)::float` })
    .from(payments)
    .innerJoin(students, eq(students.id, payments.studentId))
    .where(where);
  return { rows: rows.map((r) => ({ ...r.payment, studentName: r.studentName, admissionNo: r.admissionNo, receivedByName: r.receivedByName })), total: agg.n, amountTotal: agg.total };
}

export async function receiptPdf(ctx: Ctx, paymentId: string) {
  requirePermission(ctx, 'fees.view');
  const [row] = await ctx.db
    .select({ p: payments, s: students, receivedBy: users.fullName })
    .from(payments)
    .innerJoin(students, eq(students.id, payments.studentId))
    .leftJoin(users, eq(users.id, payments.receivedBy))
    .where(and(eq(payments.id, paymentId), eq(payments.schoolId, ctx.schoolId)));
  must(row, 'Payment');
  await assertStudentAccess(ctx, row.s.id);
  if (row.p.status !== 'completed') throw badRequest('Receipts are only available for completed payments');
  const allocs = await ctx.db
    .select({ title: feeInvoices.title, amount: paymentAllocations.amount, dueDate: feeInvoices.dueDate })
    .from(paymentAllocations)
    .innerJoin(feeInvoices, eq(feeInvoices.id, paymentAllocations.invoiceId))
    .where(eq(paymentAllocations.paymentId, paymentId));
  const [cls] = await ctx.db
    .select({ className: classes.name, sectionName: sections.name })
    .from(enrollments)
    .innerJoin(sections, eq(sections.id, enrollments.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .innerJoin(academicYears, and(eq(academicYears.id, enrollments.academicYearId), eq(academicYears.isCurrent, true)))
    .where(eq(enrollments.studentId, row.s.id));
  const [school] = await ctx.db.select({ settings: schools.settings }).from(schools).where(eq(schools.id, ctx.schoolId));
  const cur = school.settings.currency;
  const { balance } = (await studentLedger(ctx, row.s.id)).summary;

  const h = await loadSchoolHeader(ctx.schoolId);
  const doc = createDoc();
  let y = letterhead(doc, h, 'Fee Receipt', h.branding.receiptHeader);
  y = infoGrid(doc, y, [
    ['Receipt No', row.p.receiptNo],
    ['Date', row.p.paidAt.toLocaleDateString('en-IN')],
    ['Student', `${row.s.firstName} ${row.s.lastName}`],
    ['Admission No', row.s.admissionNo],
    ['Class', cls ? `${cls.className} - ${cls.sectionName}` : '—'],
    ['Payment Mode', row.p.method.replace('_', ' ').toUpperCase() + (row.p.reference ? ` (${row.p.reference})` : '')],
  ]);
  y = table(
    doc,
    y + 4,
    [
      { label: '#', width: 0.08 },
      { label: 'Particulars', width: 0.6 },
      { label: 'Amount', width: 0.32, align: 'right' },
    ],
    [...allocs.map((a, i) => [i + 1, a.title, fmtMoney(a.amount, cur)]), ['', 'Total Paid', fmtMoney(row.p.amount, cur)]],
    h.branding.primaryColor,
    { boldLast: true },
  );
  doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`Current outstanding balance: ${fmtMoney(balance, cur)}`, 40, y + 4);
  doc.text(`Received by: ${row.receivedBy ?? 'Online payment'}`, 40, doc.y + 4);
  doc.moveDown(3).font('Helvetica-Bold').text('Authorised Signatory', 40, doc.y, { align: 'right', width: doc.page.width - 80 });
  footer(doc, h, h.branding.receiptFooter ?? 'This is a computer-generated receipt.');
  return { buffer: await toBuffer(doc), filename: `receipt-${row.p.receiptNo}.pdf` };
}

/** Notify parents of students with overdue dues. */
export async function sendFeeReminders(ctx: Ctx, f: { classId?: string; minBalance?: number }) {
  requirePermission(ctx, 'fees.edit');
  const today = new Date().toISOString().slice(0, 10);
  const conds: SQL[] = [eq(feeInvoices.schoolId, ctx.schoolId), inArray(feeInvoices.status, ['unpaid', 'partial']), lt(feeInvoices.dueDate, today)];
  if (f.classId) conds.push(eq(sections.classId, f.classId));
  const dues = await ctx.db
    .select({ studentId: feeInvoices.studentId, balance: sql<number>`sum(${BALANCE})::float`, name: sql<string>`max(${students.firstName} || ' ' || ${students.lastName})` })
    .from(feeInvoices)
    .innerJoin(students, eq(students.id, feeInvoices.studentId))
    .leftJoin(enrollments, and(eq(enrollments.studentId, feeInvoices.studentId), eq(enrollments.academicYearId, feeInvoices.academicYearId)))
    .leftJoin(sections, eq(sections.id, enrollments.sectionId))
    .where(and(...conds))
    .groupBy(feeInvoices.studentId);
  let notified = 0;
  const [school] = await ctx.db.select({ settings: schools.settings }).from(schools).where(eq(schools.id, ctx.schoolId));
  for (const d of dues.filter((d) => d.balance >= (f.minBalance ?? 0.01))) {
    const res = await notifyFamilies(ctx.db, ctx.schoolId, [d.studentId], {
      type: 'fee_reminder',
      title: `Fee reminder for ${d.name}`,
      body: `Overdue balance: ${fmtMoney(d.balance, school.settings.currency)}. Please pay at the earliest.`,
      link: '/fees',
      event: 'fee_reminder',
      vars: { amount: fmtMoney(d.balance, school.settings.currency), link: payLink(d.studentId) },
      who: { parents: true },
      createdBy: ctx.userId,
    });
    notified += res?.queued ?? 0;
  }
  return { students: dues.length, notified };
}
