import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { PAYMENT_METHODS } from '@edumin/shared';
import { feeHeads, feeStructures, feeInvoices, payments } from '../../db/schema';
import { conflict, badRequest, must } from '../../core/errors';
import { ctxOf, guard, idParam, ok, sendFile, typed, type App } from '../../core/http';
import { assertStudentAccess, requirePermission } from '../../core/context';
import { env } from '../../core/env';
import {
  adjustInput,
  adjustInvoice,
  applyLateFees,
  cancelInvoice,
  concessionInput,
  confirmOnlinePayment,
  createConcession,
  createStructure,
  deleteConcession,
  generateInvoices,
  headInput,
  initiateOnlinePayment,
  invoiceListQuery,
  listConcessions,
  listHeads,
  listInvoices,
  listPayments,
  listStructures,
  paymentInput,
  receiptPdf,
  recordPayment,
  sendFeeReminders,
  structureInput,
  studentLedger,
  updateStructure,
} from './service';

const F = { feature: 'fees' as const };

export async function feeRoutes(app: App) {
  const r = typed(app);

  // Heads
  r.get('/fees/heads', { preValidation: guard('fees.view', F), schema: { tags: ['Fees'] } }, async (req) => ok(await listHeads(ctxOf(req))));
  r.post('/fees/heads', { preValidation: guard('fees.create', F), schema: { tags: ['Fees'], body: headInput } }, async (req) => {
    const ctx = ctxOf(req);
    const [row] = await ctx.db.insert(feeHeads).values({ ...req.body, schoolId: ctx.schoolId }).returning();
    return ok(row);
  });
  r.put('/fees/heads/:id', { preValidation: guard('fees.edit', F), schema: { tags: ['Fees'], params: idParam, body: headInput } }, async (req) => {
    const ctx = ctxOf(req);
    const [row] = await ctx.db.update(feeHeads).set(req.body).where(and(eq(feeHeads.id, req.params.id), eq(feeHeads.schoolId, ctx.schoolId))).returning();
    return ok(must(row, 'Fee head'));
  });
  r.delete('/fees/heads/:id', { preValidation: guard('fees.delete', F), schema: { tags: ['Fees'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    await ctx.db.delete(feeHeads).where(and(eq(feeHeads.id, req.params.id), eq(feeHeads.schoolId, ctx.schoolId)));
    return ok({ deleted: true });
  });

  // Structures
  r.get('/fees/structures', { preValidation: guard('fees.view', F), schema: { tags: ['Fees'], querystring: z.object({ academicYearId: z.uuid().optional() }) } }, async (req) =>
    ok(await listStructures(ctxOf(req), req.query.academicYearId)),
  );
  r.post('/fees/structures', { preValidation: guard('fees.create', F), schema: { tags: ['Fees'], body: structureInput } }, async (req) => ok(await createStructure(ctxOf(req), req.body)));
  r.put('/fees/structures/:id', { preValidation: guard('fees.edit', F), schema: { tags: ['Fees'], params: idParam, body: structureInput } }, async (req) =>
    ok(await updateStructure(ctxOf(req), req.params.id, req.body)),
  );
  r.delete('/fees/structures/:id', { preValidation: guard('fees.delete', F), schema: { tags: ['Fees'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    const [used] = await ctx.db.select({ id: feeInvoices.id }).from(feeInvoices).where(eq(feeInvoices.feeStructureId, req.params.id)).limit(1);
    if (used) throw conflict('Invoices exist for this structure. Deactivate it instead.');
    await ctx.db.delete(feeStructures).where(and(eq(feeStructures.id, req.params.id), eq(feeStructures.schoolId, ctx.schoolId)));
    return ok({ deleted: true });
  });

  r.post(
    '/fees/generate',
    {
      preValidation: guard('fees.create', F),
      schema: {
        tags: ['Fees'],
        summary: 'Create invoices from active fee structures (idempotent)',
        body: z.object({ academicYearId: z.uuid().optional(), structureId: z.uuid().optional(), classId: z.uuid().optional(), upToDate: z.iso.date().nullish() }),
      },
    },
    async (req) => ok(await generateInvoices(ctxOf(req), req.body)),
  );
  r.post('/fees/late-fees', { preValidation: guard('fees.edit', F), schema: { tags: ['Fees'] } }, async (req) => ok(await applyLateFees(ctxOf(req))));
  r.post('/fees/reminders', { preValidation: guard('fees.edit', F), schema: { tags: ['Fees'], body: z.object({ classId: z.uuid().optional(), minBalance: z.coerce.number().optional() }) } }, async (req) =>
    ok(await sendFeeReminders(ctxOf(req), req.body)),
  );

  // Concessions
  r.get('/fees/concessions', { preValidation: guard('fees.view', F), schema: { tags: ['Fees'], querystring: z.object({ studentId: z.uuid().optional(), academicYearId: z.uuid().optional() }) } }, async (req) =>
    ok(await listConcessions(ctxOf(req), req.query)),
  );
  r.post('/fees/concessions', { preValidation: guard('fees.approve', F), schema: { tags: ['Fees'], body: concessionInput } }, async (req) => ok(await createConcession(ctxOf(req), req.body)));
  r.delete('/fees/concessions/:id', { preValidation: guard('fees.approve', F), schema: { tags: ['Fees'], params: idParam } }, async (req) => {
    await deleteConcession(ctxOf(req), req.params.id);
    return ok({ deleted: true });
  });

  // Invoices & ledger
  r.get('/fees/invoices', { preValidation: guard('fees.view', F), schema: { tags: ['Fees'], querystring: invoiceListQuery } }, async (req) => {
    const res = await listInvoices(ctxOf(req), req.query);
    return { ...ok(res.rows, { page: req.query.page, pageSize: req.query.pageSize, total: res.total }), summary: { balance: res.balanceTotal } };
  });
  r.post('/fees/invoices/:id/cancel', { preValidation: guard('fees.delete', F), schema: { tags: ['Fees'], params: idParam } }, async (req) => {
    await cancelInvoice(ctxOf(req), req.params.id);
    return ok({ cancelled: true });
  });
  r.patch('/fees/invoices/:id', { preValidation: guard('fees.approve', F), schema: { tags: ['Fees'], params: idParam, body: adjustInput } }, async (req) =>
    ok(await adjustInvoice(ctxOf(req), req.params.id, req.body)),
  );
  r.get('/fees/students/:id/ledger', { preValidation: guard('fees.view', F), schema: { tags: ['Fees'], params: idParam, querystring: z.object({ academicYearId: z.uuid().optional() }) } }, async (req) =>
    ok(await studentLedger(ctxOf(req), req.params.id, req.query.academicYearId)),
  );

  // Payments
  r.get(
    '/fees/payments',
    {
      preValidation: guard('fees.view', F),
      schema: {
        tags: ['Fees'],
        querystring: z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(500).default(25),
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
          method: z.enum(PAYMENT_METHODS).optional(),
          search: z.string().optional(),
          studentId: z.uuid().optional(),
        }),
      },
    },
    async (req) => {
      const res = await listPayments(ctxOf(req), req.query);
      return { ...ok(res.rows, { page: req.query.page, pageSize: req.query.pageSize, total: res.total }), summary: { amount: res.amountTotal } };
    },
  );
  r.post('/fees/payments', { preValidation: guard('fees.create', F), schema: { tags: ['Fees'], summary: 'Record a cash/bank/cheque payment', body: paymentInput } }, async (req) => {
    const res = await recordPayment(ctxOf(req), req.body);
    return ok({ id: res.payment.id, receiptNo: res.payment.receiptNo, allocations: res.allocations });
  });
  r.get('/fees/payments/:id/receipt', { preValidation: guard('fees.view', F), schema: { tags: ['Fees'], params: idParam } }, async (req, reply) => {
    const { buffer, filename } = await receiptPdf(ctxOf(req), req.params.id);
    return sendFile(reply, buffer, filename, 'application/pdf');
  });

  // Online payments (gateway architecture; mock gateway in development)
  r.post(
    '/fees/online/initiate',
    { preValidation: guard('fees.view', F), schema: { tags: ['Fees'], body: z.object({ studentId: z.uuid(), amount: z.coerce.number().positive(), invoiceIds: z.array(z.uuid()).optional() }) } },
    async (req) => ok(await initiateOnlinePayment(ctxOf(req), req.body)),
  );
  r.post(
    '/fees/online/:id/mock-complete',
    { preValidation: guard('fees.view', F), schema: { tags: ['Fees'], summary: 'Mock gateway only: simulate the payer completing checkout', params: idParam, body: z.object({ success: z.boolean() }) } },
    async (req) => {
      if (env.PAYMENT_GATEWAY !== 'mock') throw badRequest('Not available with a live gateway');
      const ctx = ctxOf(req);
      requirePermission(ctx, 'fees.view');
      const [p] = await ctx.db.select({ studentId: payments.studentId }).from(payments).where(and(eq(payments.id, req.params.id), eq(payments.schoolId, ctx.schoolId)));
      await assertStudentAccess(ctx, must(p, 'Payment').studentId);
      return ok(await confirmOnlinePayment(ctx, req.params.id, req.body.success));
    },
  );
}
