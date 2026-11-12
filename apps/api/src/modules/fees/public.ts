/**
 * Login-free fee payment ("pay link" sent in fee reminders) and the per-school
 * Razorpay webhook. The link is signed per student and expires after 30 days.
 */
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { classes, enrollments, academicYears, feeInvoices, payments, schools, sections, students } from '../../db/schema';
import { db } from '../../core/db';
import { env } from '../../core/env';
import { badRequest, forbidden, must } from '../../core/errors';
import { ok, typed, type App } from '../../core/http';
import { systemCtx } from '../../core/context';
import { verifyLink } from '../../core/crypto';
import { verifyWebhookSignature } from '../../core/razorpay';
import { BALANCE, confirmOnlinePayment, initiateOnlinePayment, verifyOnlinePayment } from './service';
import { availableGateway, schoolRazorpay } from './gateway';

const linkQuery = z.object({ exp: z.coerce.number(), sig: z.string() });
const params = z.object({ studentId: z.uuid() });

async function resolve(studentId: string, q: z.infer<typeof linkQuery>) {
  if (!verifyLink(`pay:${studentId}`, q.exp, q.sig)) throw forbidden('This payment link has expired. Please ask the school for a new one.');
  const [s] = await db.select().from(students).where(eq(students.id, studentId));
  must(s, 'Student');
  return s;
}

export async function feePublicRoutes(app: App) {
  const r = typed(app);
  const limit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  r.get('/public/pay/:studentId', { config: limit, schema: { tags: ['Public'], params, querystring: linkQuery } }, async (req) => {
    const s = await resolve(req.params.studentId, req.query);
    const [school] = await db.select().from(schools).where(eq(schools.id, s.schoolId));
    const [cls] = await db
      .select({ label: sql<string>`${classes.name} || ' - ' || ${sections.name}` })
      .from(enrollments)
      .innerJoin(sections, eq(sections.id, enrollments.sectionId))
      .innerJoin(classes, eq(classes.id, sections.classId))
      .innerJoin(academicYears, and(eq(academicYears.id, enrollments.academicYearId), eq(academicYears.isCurrent, true)))
      .where(eq(enrollments.studentId, s.id));
    const invoices = await db
      .select({ id: feeInvoices.id, title: feeInvoices.title, dueDate: feeInvoices.dueDate, balance: BALANCE })
      .from(feeInvoices)
      .where(and(eq(feeInvoices.studentId, s.id), inArray(feeInvoices.status, ['unpaid', 'partial'])))
      .orderBy(asc(feeInvoices.dueDate));
    return ok({
      school: { name: school.name, logoUrl: school.branding.logoUrl, primaryColor: school.branding.primaryColor, phone: school.branding.phone },
      student: { name: `${s.firstName} ${s.lastName}`.trim(), admissionNo: s.admissionNo, classLabel: cls?.label ?? null },
      invoices: invoices.map((i) => ({ ...i, balance: Math.round(Number(i.balance) * 100) / 100 })),
      gateway: await availableGateway(db, s.schoolId),
    });
  });

  r.post(
    '/public/pay/:studentId/order',
    { config: limit, schema: { tags: ['Public'], params, querystring: linkQuery, body: z.object({ invoiceIds: z.array(z.uuid()).min(1) }) } },
    async (req) => {
      const s = await resolve(req.params.studentId, req.query);
      const ctx = systemCtx(s.schoolId);
      const open = await db
        .select({ id: feeInvoices.id, balance: BALANCE })
        .from(feeInvoices)
        .where(and(eq(feeInvoices.studentId, s.id), inArray(feeInvoices.id, req.body.invoiceIds), inArray(feeInvoices.status, ['unpaid', 'partial'])));
      const amount = Math.round(open.reduce((a, i) => a + Number(i.balance), 0) * 100) / 100;
      if (amount <= 0) throw badRequest('Nothing to pay for the selected fees');
      return ok(await initiateOnlinePayment(ctx, { studentId: s.id, amount, invoiceIds: open.map((i) => i.id) }));
    },
  );

  r.post(
    '/public/pay/:studentId/verify',
    {
      config: limit,
      schema: { tags: ['Public'], params, querystring: linkQuery, body: z.object({ paymentId: z.uuid(), razorpay_payment_id: z.string(), razorpay_order_id: z.string(), razorpay_signature: z.string() }) },
    },
    async (req) => {
      const s = await resolve(req.params.studentId, req.query);
      const { paymentId, ...rz } = req.body;
      const p = await verifyOnlinePayment(systemCtx(s.schoolId), paymentId, rz);
      return ok({ receiptNo: p.receiptNo, amount: p.amount, status: p.status });
    },
  );

  r.post(
    '/public/pay/:studentId/mock-complete',
    { config: limit, schema: { tags: ['Public'], params, querystring: linkQuery, body: z.object({ paymentId: z.uuid(), success: z.boolean() }) } },
    async (req) => {
      if (env.PAYMENT_GATEWAY !== 'mock') throw badRequest('Not available');
      const s = await resolve(req.params.studentId, req.query);
      const [p] = await db.select().from(payments).where(and(eq(payments.id, req.body.paymentId), eq(payments.studentId, s.id), eq(payments.gateway, 'mock')));
      must(p, 'Payment');
      const row = await confirmOnlinePayment(systemCtx(s.schoolId), p.id, req.body.success);
      return ok({ receiptNo: row.receiptNo, amount: row.amount, status: row.status });
    },
  );
}

/** Razorpay → school webhook. Configure in the school's Razorpay dashboard (event: payment.captured). */
export async function feeWebhookRoutes(app: App) {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });
  typed(app).post('/webhooks/razorpay/school/:schoolId', { schema: { hide: true, params: z.object({ schoolId: z.uuid() }) } }, async (req, reply) => {
    const keys = await schoolRazorpay(db, req.params.schoolId);
    if (!keys?.webhookSecret) return reply.status(404).send('Not configured');
    if (!verifyWebhookSignature(keys.webhookSecret, (req as any).rawBody ?? '', String(req.headers['x-razorpay-signature'] ?? ''))) return reply.status(401).send('Bad signature');
    const body = req.body as any;
    const payment = body?.payload?.payment?.entity;
    if (['payment.captured', 'order.paid'].includes(body?.event) && payment?.order_id) {
      const [p] = await db.select().from(payments).where(and(eq(payments.schoolId, req.params.schoolId), eq(payments.gatewayRef, payment.order_id)));
      if (p && p.status === 'pending') {
        await db.update(payments).set({ reference: payment.id }).where(eq(payments.id, p.id));
        await confirmOnlinePayment(systemCtx(req.params.schoolId), p.id, true);
      }
    }
    return reply.send({ ok: true });
  });
}
