import { z } from 'zod';
import { and, count, desc, eq, gte, ilike, or, sql } from 'drizzle-orm';
import { CHANNELS, CREDIT_COST, CREDIT_PACKS, MESSAGE_EVENT_KEYS, type Channel } from '@edumin/shared';
import { creditOrders, creditTransactions, outboundMessages, schools } from '../../db/schema';
import { db } from '../../core/db';
import { env } from '../../core/env';
import { badRequest, conflict, forbidden, must, notFound } from '../../core/errors';
import { ctxOf, guard, idParam, ok, pageQuery, sendFile, typed, type App } from '../../core/http';
import type { Ctx } from '../../core/context';
import { verifyLink, hmacHex, safeEqual } from '../../core/crypto';
import { createOrder, verifyPaymentSignature, verifyWebhookSignature } from '../../core/razorpay';
import { audit } from '../../core/audit';
import { addCredits, applyDeliveryStatus, dispatch, familyRecipients, renderMessageAttachment, reserveCredits } from './service';
import { providerStatus } from './providers';
import { computeResults } from '../exams/service';

const channelSchema = z.enum(CHANNELS);

const settingsBody = z.object({
  channels: z.object({ email: z.boolean(), whatsapp: z.boolean(), sms: z.boolean() }),
  events: z.record(z.enum(MESSAGE_EVENT_KEYS as [string, ...string[]]), z.array(channelSchema)),
  lowCreditAlert: z.coerce.number().int().min(0).max(1_000_000),
});

const platformRazorpay = () => (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET } : null);

/** Marks a credit order paid and adds the credits — idempotent (checkout callback and webhook may both arrive). */
async function fulfilOrder(orderId: string, paymentId: string | null, by: string | null) {
  return db.transaction(async (tx) => {
    const [o] = await tx
      .update(creditOrders)
      .set({ status: 'paid', paidAt: new Date(), gatewayPaymentId: paymentId })
      .where(and(eq(creditOrders.id, orderId), eq(creditOrders.status, 'pending')))
      .returning();
    if (!o) return null;
    const balance = await addCredits(tx, o.schoolId, o.credits, { kind: 'purchase', note: `Bought ${o.credits.toLocaleString('en-IN')} credits`, amountPaid: o.amount, reference: paymentId ?? o.id, createdBy: by });
    return { order: o, balance };
  });
}

async function overview(ctx: Ctx) {
  const [s] = await ctx.db.select({ messaging: schools.messaging, credits: schools.messageCredits }).from(schools).where(eq(schools.id, ctx.schoolId));
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const stats = await ctx.db
    .select({
      channel: outboundMessages.channel,
      total: sql<number>`count(*)::int`,
      delivered: sql<number>`count(*) filter (where ${outboundMessages.status} in ('delivered','read'))::int`,
      failed: sql<number>`count(*) filter (where ${outboundMessages.status} in ('failed','skipped'))::int`,
      credits: sql<number>`coalesce(sum(${outboundMessages.credits}),0)::int`,
    })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.schoolId, ctx.schoolId), gte(outboundMessages.createdAt, monthStart)))
    .groupBy(outboundMessages.channel);
  return {
    settings: s.messaging,
    credits: s.credits,
    featureEnabled: ctx.features.has('messaging'),
    providers: providerStatus(),
    packs: CREDIT_PACKS,
    checkout: platformRazorpay() ? 'razorpay' : 'mock',
    thisMonth: stats,
  };
}

export async function messagingRoutes(app: App) {
  const r = typed(app);

  r.get('/messaging', { preValidation: guard('messaging.view'), schema: { tags: ['Messaging'], summary: 'Channel settings, credit balance, provider status and this month’s stats' } }, async (req) =>
    ok(await overview(ctxOf(req))),
  );

  r.put('/messaging/settings', { preValidation: guard('messaging.edit'), schema: { tags: ['Messaging'], body: settingsBody } }, async (req) => {
    const ctx = ctxOf(req);
    const b = req.body;
    if ((b.channels.whatsapp || b.channels.sms) && !ctx.features.has('messaging')) throw forbidden('WhatsApp and SMS are not included in your plan');
    await ctx.db.update(schools).set({ messaging: b as any }).where(eq(schools.id, ctx.schoolId));
    await audit(ctx, 'update', 'messaging_settings', ctx.schoolId, b.channels);
    return ok(await overview(ctx));
  });

  r.get(
    '/messaging/log',
    {
      preValidation: guard('messaging.view'),
      schema: { tags: ['Messaging'], querystring: pageQuery.extend({ channel: channelSchema.optional(), status: z.string().optional(), event: z.string().optional() }) },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const { page, pageSize, search, channel, status, event } = req.query;
      const where = and(
        eq(outboundMessages.schoolId, ctx.schoolId),
        channel ? eq(outboundMessages.channel, channel) : undefined,
        status ? (status === 'failed' ? sql`${outboundMessages.status} in ('failed','skipped')` : eq(outboundMessages.status, status)) : undefined,
        event ? eq(outboundMessages.event, event) : undefined,
        search ? or(ilike(outboundMessages.recipient, `%${search}%`), ilike(outboundMessages.recipientName, `%${search}%`), ilike(outboundMessages.body, `%${search}%`)) : undefined,
      );
      const rows = await ctx.db
        .select({
          id: outboundMessages.id,
          channel: outboundMessages.channel,
          event: outboundMessages.event,
          recipient: outboundMessages.recipient,
          recipientName: outboundMessages.recipientName,
          subject: outboundMessages.subject,
          body: outboundMessages.body,
          hasAttachment: sql<boolean>`${outboundMessages.attachment} is not null`,
          status: outboundMessages.status,
          credits: outboundMessages.credits,
          error: outboundMessages.error,
          createdAt: outboundMessages.createdAt,
          deliveredAt: outboundMessages.deliveredAt,
        })
        .from(outboundMessages)
        .where(where)
        .orderBy(desc(outboundMessages.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [{ n }] = await ctx.db.select({ n: count() }).from(outboundMessages).where(where);
      return ok(rows, { page, pageSize, total: n });
    },
  );

  r.post('/messaging/:id/retry', { preValidation: guard('messaging.create'), schema: { tags: ['Messaging'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    const [m] = await ctx.db.select().from(outboundMessages).where(and(eq(outboundMessages.id, req.params.id), eq(outboundMessages.schoolId, ctx.schoolId)));
    must(m, 'Message');
    if (!['failed', 'skipped'].includes(m.status)) throw badRequest('Only failed or skipped messages can be retried');
    // Re-queue the original message; paid channels reserve their credits again.
    if (m.credits === 0 && m.channel !== 'email') {
      const cost = CREDIT_COST[m.channel as Channel];
      const balance = await reserveCredits(ctx.db, ctx.schoolId, cost);
      if (balance === null) throw badRequest('Not enough message credits');
      await ctx.db.insert(creditTransactions).values({ schoolId: ctx.schoolId, delta: -cost, balanceAfter: balance, kind: 'usage', note: `Retry ${m.channel} to ${m.recipient}`, reference: m.id, createdBy: ctx.userId });
      m.credits = cost;
    }
    await ctx.db.update(outboundMessages).set({ status: 'queued', attempts: 0, error: null, credits: m.credits }).where(eq(outboundMessages.id, m.id));
    return ok({ queued: 1 });
  });

  r.post(
    '/messaging/test',
    { preValidation: guard('messaging.edit'), schema: { tags: ['Messaging'], summary: 'Send a test message (uses credits for WhatsApp/SMS)', body: z.object({ channel: channelSchema, to: z.string().trim().min(5).max(255) }) } },
    async (req) => {
      const ctx = ctxOf(req);
      const { channel, to } = req.body;
      if (channel === 'email' && !to.includes('@')) throw badRequest('Enter an email address');
      const res = await dispatch(ctx.db, ctx.schoolId, {
        event: 'announcement',
        channels: [channel],
        createdBy: ctx.userId,
        items: [{ recipient: channel === 'email' ? { email: to, name: 'Test' } : { phone: to, name: 'Test' }, vars: { title: 'Test message', message: 'Your school messaging is set up correctly.' } }],
      });
      if (!res.queued) throw badRequest(res.reason ?? 'Could not send — check the number or that the channel is turned on');
      return ok(res);
    },
  );

  /** Send report cards for one section (e.g. a resend after corrections). */
  r.post(
    '/messaging/report-cards',
    {
      preValidation: guard(['messaging.create', 'exams.view']),
      schema: { tags: ['Messaging'], body: z.object({ examId: z.uuid(), sectionId: z.uuid(), channels: z.array(channelSchema).min(1) }) },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const { exam, results } = await computeResults(ctx, req.body.examId, { sectionId: req.body.sectionId });
      if (exam.status !== 'published') throw badRequest('Publish the results before sending report cards');
      const ready = results.filter((r) => r.percentage !== null);
      if (!ready.length) throw badRequest('No results in this section');
      const families = await familyRecipients(ctx.db, ctx.schoolId, ready.map((r) => r.studentId));
      return ok(
        await dispatch(ctx.db, ctx.schoolId, {
          event: 'exam_results',
          channels: req.body.channels,
          createdBy: ctx.userId,
          items: ready
            .filter((r) => families.has(r.studentId))
            .map((r) => ({
              recipient: families.get(r.studentId)!,
              vars: { student: r.name, exam: exam.name, result: `${r.percentage}%, grade ${r.grade ?? '-'}${r.rank ? `, rank ${r.rank}` : ''}` },
              attachment: { kind: 'report_card' as const, ref: { examId: exam.id, studentId: r.studentId }, filename: `report-card-${r.admissionNo}.pdf` },
            })),
        }),
      );
    },
  );

  // ── Credits ──
  r.get('/messaging/credits', { preValidation: guard('messaging.view'), schema: { tags: ['Messaging'] } }, async (req) => {
    const ctx = ctxOf(req);
    const rows = await ctx.db.select().from(creditTransactions).where(eq(creditTransactions.schoolId, ctx.schoolId)).orderBy(desc(creditTransactions.createdAt)).limit(100);
    return ok(rows);
  });

  r.post(
    '/messaging/credits/orders',
    { preValidation: guard('messaging.edit'), schema: { tags: ['Messaging'], summary: 'Start buying a credit pack', body: z.object({ packKey: z.string() }) } },
    async (req) => {
      const ctx = ctxOf(req);
      const pack = CREDIT_PACKS.find((p) => p.key === req.body.packKey);
      if (!pack) throw badRequest('Unknown credit pack');
      const keys = platformRazorpay();
      const [o] = await ctx.db
        .insert(creditOrders)
        .values({ schoolId: ctx.schoolId, packKey: pack.key, credits: pack.credits, amount: pack.price, gateway: keys ? 'razorpay' : 'mock', createdBy: ctx.userId })
        .returning();
      if (!keys) {
        if (env.PAYMENT_GATEWAY !== 'mock') throw badRequest('Online purchase is not available yet. Contact support to buy credits.');
        return ok({ orderId: o.id, gateway: 'mock' as const, amount: pack.price, credits: pack.credits });
      }
      const rz = await createOrder(keys, { amountInr: pack.price, receipt: `cr_${o.id.slice(0, 8)}`, notes: { creditOrderId: o.id, schoolId: ctx.schoolId } });
      await ctx.db.update(creditOrders).set({ gatewayOrderId: rz.id }).where(eq(creditOrders.id, o.id));
      return ok({ orderId: o.id, gateway: 'razorpay' as const, razorpayOrderId: rz.id, keyId: keys.keyId, amount: pack.price, credits: pack.credits });
    },
  );

  r.post(
    '/messaging/credits/orders/:id/verify',
    {
      preValidation: guard('messaging.edit'),
      schema: { tags: ['Messaging'], params: idParam, body: z.object({ razorpay_payment_id: z.string(), razorpay_order_id: z.string(), razorpay_signature: z.string() }) },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const keys = platformRazorpay();
      if (!keys) throw badRequest('Online payment is not configured');
      const [o] = await ctx.db.select().from(creditOrders).where(and(eq(creditOrders.id, req.params.id), eq(creditOrders.schoolId, ctx.schoolId)));
      must(o, 'Order');
      if (o.gatewayOrderId !== req.body.razorpay_order_id || !verifyPaymentSignature(keys.keySecret, req.body.razorpay_order_id, req.body.razorpay_payment_id, req.body.razorpay_signature)) {
        throw badRequest('Payment verification failed');
      }
      const res = await fulfilOrder(o.id, req.body.razorpay_payment_id, ctx.userId);
      return ok({ credits: o.credits, balance: res?.balance ?? null });
    },
  );

  r.post('/messaging/credits/orders/:id/mock-pay', { preValidation: guard('messaging.edit'), schema: { tags: ['Messaging'], summary: 'Test mode only: simulate paying for a credit pack', params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    if (platformRazorpay() || env.PAYMENT_GATEWAY !== 'mock') throw badRequest('Not available');
    const [o] = await ctx.db.select().from(creditOrders).where(and(eq(creditOrders.id, req.params.id), eq(creditOrders.schoolId, ctx.schoolId)));
    must(o, 'Order');
    const res = await fulfilOrder(o.id, `mock_${Date.now()}`, ctx.userId);
    if (!res) throw conflict('This order was already paid');
    return ok({ credits: o.credits, balance: res.balance });
  });
}

/** Unauthenticated endpoints: signed attachment downloads and provider webhooks. */
export async function messagingPublicRoutes(app: App) {
  const r = typed(app);

  r.get(
    '/public/messages/:id/attachment',
    { schema: { hide: true, params: idParam, querystring: z.object({ exp: z.coerce.number(), sig: z.string() }) } },
    async (req, reply) => {
      if (!verifyLink(`msg:${req.params.id}`, req.query.exp, req.query.sig)) throw forbidden('This link has expired');
      const file = await renderMessageAttachment(req.params.id);
      if (!file) throw notFound('Attachment');
      return sendFile(reply, file.buffer, file.filename, 'application/pdf');
    },
  );

  // Webhooks need the raw body for signature checks, so JSON is parsed here manually.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  /** Meta webhook verification handshake. */
  r.get('/webhooks/whatsapp', { schema: { hide: true } }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && q['hub.verify_token'] === env.WHATSAPP_VERIFY_TOKEN) return reply.type('text/plain').send(q['hub.challenge']);
    return reply.status(403).send('Forbidden');
  });

  /** Delivery status updates for messages sent from the platform number. */
  r.post('/webhooks/whatsapp', { schema: { hide: true } }, async (req, reply) => {
    if (env.WHATSAPP_APP_SECRET) {
      const sig = String(req.headers['x-hub-signature-256'] ?? '');
      if (!safeEqual(sig, 'sha256=' + hmacHex(env.WHATSAPP_APP_SECRET, (req as any).rawBody ?? ''))) return reply.status(401).send('Bad signature');
    }
    const body = req.body as any;
    for (const entry of body?.entry ?? [])
      for (const change of entry.changes ?? [])
        for (const s of change.value?.statuses ?? []) await applyDeliveryStatus(String(s.id), String(s.status), s.errors?.[0]?.title ?? null);
    return reply.send({ ok: true });
  });

  /** Platform Razorpay account: credit pack purchases. */
  r.post('/webhooks/razorpay/platform', { schema: { hide: true } }, async (req, reply) => {
    if (!env.RAZORPAY_WEBHOOK_SECRET) return reply.status(404).send('Not configured');
    if (!verifyWebhookSignature(env.RAZORPAY_WEBHOOK_SECRET, (req as any).rawBody ?? '', String(req.headers['x-razorpay-signature'] ?? ''))) return reply.status(401).send('Bad signature');
    const body = req.body as any;
    const payment = body?.payload?.payment?.entity;
    if (['payment.captured', 'order.paid'].includes(body?.event) && payment?.order_id) {
      const [o] = await db.select().from(creditOrders).where(eq(creditOrders.gatewayOrderId, payment.order_id));
      if (o) await fulfilOrder(o.id, payment.id, null);
    }
    return reply.send({ ok: true });
  });
}

