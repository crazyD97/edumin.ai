/** Platform Super Admin: tenants, plans, subscriptions, usage. */
import { z } from 'zod';
import { and, asc, count, desc, eq, gte, ilike, or, sql, sum } from 'drizzle-orm';
import { ALL_FEATURES, SCHOOL_STATUSES } from '@edumin/shared';
import { db } from '../../core/db';
import { creditOrders, creditTransactions, files, outboundMessages, plans, schools, students, subscriptionEvents, users, payments, roles } from '../../db/schema';
import { addCredits } from '../messaging/service';
import { conflict, must } from '../../core/errors';
import { effectiveFeatures, idParam, ok, pageQuery, platformCtxOf, typed, type App } from '../../core/http';
import { provisionSchool } from './provision';
import { audit } from '../../core/audit';
import { hashPassword } from '../../core/auth';

const slugRe = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const RESERVED = ['www', 'app', 'api', 'admin', 'platform', 'mail', 'static'];

const planBody = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]+$/).max(50),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().nullish(),
  priceMonthly: z.coerce.number().min(0),
  priceYearly: z.coerce.number().min(0),
  maxStudents: z.coerce.number().int().positive().nullish(),
  maxStaff: z.coerce.number().int().positive().nullish(),
  features: z.array(z.enum(ALL_FEATURES as [string, ...string[]])),
  isActive: z.boolean().default(true),
});

async function usageFor(schoolId: string) {
  const [[s], [u], [f], [p]] = await Promise.all([
    db.select({ n: count() }).from(students).where(and(eq(students.schoolId, schoolId), eq(students.status, 'active'))),
    db
      .select({ n: count() })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.schoolId, schoolId), sql`${roles.key} not in ('student','parent')`)),
    db.select({ n: sum(files.size) }).from(files).where(eq(files.schoolId, schoolId)),
    db.select({ n: sum(payments.amount) }).from(payments).where(and(eq(payments.schoolId, schoolId), eq(payments.status, 'completed'))),
  ]);
  return { activeStudents: s.n, staff: u.n, storageBytes: Number(f.n ?? 0), feesCollected: Number(p.n ?? 0) };
}

export async function platformRoutes(app: App) {
  const r = typed(app);
  app.addHook('preValidation', async (req) => {
    platformCtxOf(req);
  });

  r.get('/platform/stats', { schema: { tags: ['Platform'], summary: 'Platform-wide statistics' } }, async () => {
    const byStatus = await db.select({ status: schools.status, n: count() }).from(schools).groupBy(schools.status);
    const [[st], [us]] = await Promise.all([
      db.select({ n: count() }).from(students).where(eq(students.status, 'active')),
      db.select({ n: count() }).from(users),
    ]);
    const byPlan = await db
      .select({ plan: sql<string>`coalesce(${plans.name}, 'No plan')`, n: count(), mrr: sql<number>`coalesce(sum(case when ${schools.status} = 'active' then ${plans.priceMonthly} else 0 end),0)::float` })
      .from(schools)
      .leftJoin(plans, eq(plans.id, schools.planId))
      .groupBy(plans.name);
    const growth = await db
      .select({ month: sql<string>`to_char(date_trunc('month', ${schools.createdAt}), 'YYYY-MM')`, n: count() })
      .from(schools)
      .where(sql`${schools.createdAt} > now() - interval '12 months'`)
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const expiringTrials = await db
      .select({ id: schools.id, name: schools.name, slug: schools.slug, trialEndsAt: schools.trialEndsAt })
      .from(schools)
      .where(and(eq(schools.status, 'trial'), sql`${schools.trialEndsAt} < now() + interval '14 days'`))
      .orderBy(asc(schools.trialEndsAt))
      .limit(10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const messages = await db
      .select({ channel: outboundMessages.channel, n: sql<number>`count(*)::int` })
      .from(outboundMessages)
      .where(gte(outboundMessages.createdAt, monthStart))
      .groupBy(outboundMessages.channel);
    const [credits] = await db
      .select({ revenue: sql<number>`coalesce(sum(${creditOrders.amount}),0)::float`, sold: sql<number>`coalesce(sum(${creditOrders.credits}),0)::int` })
      .from(creditOrders)
      .where(and(eq(creditOrders.status, 'paid'), gte(creditOrders.paidAt, monthStart)));
    const statusMap = Object.fromEntries(byStatus.map((b) => [b.status, b.n]));
    return ok({
      schools: { total: byStatus.reduce((a, b) => a + b.n, 0), ...statusMap },
      activeStudents: st.n,
      users: us.n,
      mrr: byPlan.reduce((a, b) => a + Number(b.mrr), 0),
      byPlan,
      growth,
      expiringTrials,
      messagesThisMonth: messages,
      creditsThisMonth: credits,
    });
  });

  // ── Schools ──
  r.get(
    '/platform/schools',
    { schema: { tags: ['Platform'], querystring: pageQuery.extend({ status: z.enum(SCHOOL_STATUSES).optional() }) } },
    async (req) => {
      const { page, pageSize, search, status } = req.query;
      const where = and(
        status ? eq(schools.status, status) : undefined,
        search ? or(ilike(schools.name, `%${search}%`), ilike(schools.slug, `%${search}%`)) : undefined,
      );
      const rows = await db
        .select({
          id: schools.id,
          name: schools.name,
          slug: schools.slug,
          status: schools.status,
          subscriptionStatus: schools.subscriptionStatus,
          trialEndsAt: schools.trialEndsAt,
          subscriptionEndsAt: schools.subscriptionEndsAt,
          createdAt: schools.createdAt,
          planName: plans.name,
          studentCount: sql<number>`(select count(*)::int from ${students} where ${students.schoolId} = ${schools.id} and ${students.status} = 'active')`,
        })
        .from(schools)
        .leftJoin(plans, eq(plans.id, schools.planId))
        .where(where)
        .orderBy(desc(schools.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [{ n }] = await db.select({ n: count() }).from(schools).where(where);
      return ok(rows, { page, pageSize, total: n });
    },
  );

  r.post(
    '/platform/schools',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Onboard a new school (tenant) with its admin account',
        body: z.object({
          name: z.string().trim().min(2).max(200),
          slug: z.string().trim().toLowerCase().regex(slugRe, 'Use lowercase letters, numbers and hyphens'),
          planId: z.uuid().nullish(),
          status: z.enum(['trial', 'active']).default('trial'),
          trialDays: z.coerce.number().int().min(1).max(365).default(30),
          adminName: z.string().trim().min(2),
          adminEmail: z.email(),
          adminPassword: z.string().min(8),
          email: z.email().nullish().or(z.literal('')),
          phone: z.string().nullish(),
        }),
      },
    },
    async (req) => {
      const ctx = platformCtxOf(req);
      const b = req.body;
      if (RESERVED.includes(b.slug)) throw conflict('This subdomain is reserved');
      const [exists] = await db.select({ id: schools.id }).from(schools).where(eq(schools.slug, b.slug));
      if (exists) throw conflict('This subdomain is already taken');
      const res = await db.transaction((tx) =>
        provisionSchool(tx, {
          name: b.name,
          slug: b.slug,
          planId: b.planId,
          status: b.status,
          trialDays: b.trialDays,
          branding: { email: b.email || null, phone: b.phone || null },
          admin: { fullName: b.adminName, email: b.adminEmail, password: b.adminPassword },
        }),
      );
      await db.insert(subscriptionEvents).values({ schoolId: res.school.id, type: 'created', planId: b.planId ?? null, createdBy: ctx.userId, note: `Created as ${b.status}` });
      await audit({ ...ctx, schoolId: null }, 'create', 'school', res.school.id, { slug: b.slug });
      return ok(res.school);
    },
  );

  r.get('/platform/schools/:id', { schema: { tags: ['Platform'], params: idParam } }, async (req) => {
    const [row] = await db.select({ school: schools, plan: plans }).from(schools).leftJoin(plans, eq(plans.id, schools.planId)).where(eq(schools.id, req.params.id));
    must(row, 'School');
    const admins = await db
      .select({ id: users.id, fullName: users.fullName, email: users.email, lastLoginAt: users.lastLoginAt })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.schoolId, row.school.id), eq(roles.key, 'school_admin')));
    const history = await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.schoolId, row.school.id)).orderBy(desc(subscriptionEvents.createdAt)).limit(50);
    return ok({
      ...row.school,
      plan: row.plan,
      effectiveFeatures: effectiveFeatures(row.school, row.plan),
      usage: await usageFor(row.school.id),
      credits: row.school.messageCredits,
      creditLedger: await db.select().from(creditTransactions).where(eq(creditTransactions.schoolId, row.school.id)).orderBy(desc(creditTransactions.createdAt)).limit(30),
      admins,
      history,
    });
  });

  r.patch(
    '/platform/schools/:id',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Update status, plan, trial, subscription or feature overrides',
        params: idParam,
        body: z.object({
          name: z.string().trim().min(2).max(200).optional(),
          status: z.enum(SCHOOL_STATUSES).optional(),
          planId: z.uuid().nullable().optional(),
          trialEndsAt: z.iso.datetime({ offset: true }).or(z.iso.date()).nullable().optional(),
          subscriptionStatus: z.enum(['trialing', 'active', 'past_due', 'cancelled']).optional(),
          subscriptionEndsAt: z.iso.datetime({ offset: true }).or(z.iso.date()).nullable().optional(),
          featureOverrides: z.record(z.string(), z.boolean()).optional(),
          notes: z.string().nullable().optional(),
        }),
      },
    },
    async (req) => {
      const ctx = platformCtxOf(req);
      const b = req.body;
      const before = must((await db.select().from(schools).where(eq(schools.id, req.params.id)))[0], 'School');
      const [row] = await db
        .update(schools)
        .set({
          ...b,
          trialEndsAt: b.trialEndsAt === undefined ? undefined : b.trialEndsAt ? new Date(b.trialEndsAt) : null,
          subscriptionEndsAt: b.subscriptionEndsAt === undefined ? undefined : b.subscriptionEndsAt ? new Date(b.subscriptionEndsAt) : null,
        })
        .where(eq(schools.id, req.params.id))
        .returning();
      const events: { type: string; note: string; planId?: string | null }[] = [];
      if (b.status && b.status !== before.status) events.push({ type: `status_${b.status}`, note: `Status ${before.status} → ${b.status}` });
      if (b.planId !== undefined && b.planId !== before.planId) events.push({ type: 'plan_changed', note: 'Plan changed', planId: b.planId });
      if (b.trialEndsAt !== undefined) events.push({ type: 'trial_updated', note: `Trial ends ${b.trialEndsAt ?? 'never'}` });
      if (b.subscriptionEndsAt !== undefined) events.push({ type: 'subscription_updated', note: `Subscription ends ${b.subscriptionEndsAt ?? 'never'}` });
      for (const e of events) await db.insert(subscriptionEvents).values({ schoolId: row.id, createdBy: ctx.userId, ...e });
      await audit({ ...ctx, schoolId: null }, 'update', 'school', row.id, b);
      return ok(row);
    },
  );

  r.post(
    '/platform/schools/:id/payments',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Record a manual subscription payment and optionally extend the subscription',
        params: idParam,
        body: z.object({ amount: z.coerce.number().positive(), note: z.string().nullish(), extendMonths: z.coerce.number().int().min(0).max(36).default(0) }),
      },
    },
    async (req) => {
      const ctx = platformCtxOf(req);
      const s = must((await db.select().from(schools).where(eq(schools.id, req.params.id)))[0], 'School');
      if (req.body.extendMonths) {
        const base = s.subscriptionEndsAt && s.subscriptionEndsAt > new Date() ? new Date(s.subscriptionEndsAt) : new Date();
        base.setMonth(base.getMonth() + req.body.extendMonths);
        await db.update(schools).set({ subscriptionEndsAt: base, subscriptionStatus: 'active', status: 'active' }).where(eq(schools.id, s.id));
      }
      await db.insert(subscriptionEvents).values({
        schoolId: s.id,
        type: 'payment_recorded',
        amount: req.body.amount,
        planId: s.planId,
        note: req.body.note ?? (req.body.extendMonths ? `Extended ${req.body.extendMonths} month(s)` : null),
        createdBy: ctx.userId,
      });
      return ok({ recorded: true });
    },
  );

  r.post(
    '/platform/schools/:id/credits',
    {
      schema: {
        tags: ['Platform'],
        summary: 'Grant or deduct message credits (e.g. after an offline payment)',
        params: idParam,
        body: z.object({ credits: z.coerce.number().int().refine((n) => n !== 0, 'Enter a non-zero amount'), amountPaid: z.coerce.number().min(0).nullish(), note: z.string().trim().max(300).nullish() }),
      },
    },
    async (req) => {
      const ctx = platformCtxOf(req);
      must((await db.select({ id: schools.id, credits: schools.messageCredits }).from(schools).where(eq(schools.id, req.params.id)))[0], 'School');
      const balance = await db.transaction(async (tx) => {
        const bal = await addCredits(tx, req.params.id, req.body.credits, {
          kind: req.body.credits > 0 ? (req.body.amountPaid ? 'purchase' : 'grant') : 'adjust',
          note: req.body.note ?? (req.body.credits > 0 ? 'Credits added by platform' : 'Credits deducted by platform'),
          amountPaid: req.body.amountPaid ?? null,
          createdBy: ctx.userId,
        });
        if (bal < 0) throw conflict('That would make the balance negative'); // rolls the transaction back
        return bal;
      });
      await audit({ ...ctx, schoolId: req.params.id }, 'credits', 'school', req.params.id, req.body);
      return ok({ balance });
    },
  );

  r.post(
    '/platform/schools/:id/reset-admin-password',
    { schema: { tags: ['Platform'], params: idParam, body: z.object({ userId: z.uuid(), password: z.string().min(8) }) } },
    async (req) => {
      const ctx = platformCtxOf(req);
      const [u] = await db
        .update(users)
        .set({ passwordHash: await hashPassword(req.body.password), tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(and(eq(users.id, req.body.userId), eq(users.schoolId, req.params.id)))
        .returning({ id: users.id });
      must(u, 'User');
      await audit({ ...ctx, schoolId: req.params.id }, 'reset_password', 'user', u.id);
      return ok({ reset: true });
    },
  );

  // ── Plans ──
  r.get('/platform/plans', { schema: { tags: ['Platform'] } }, async () => {
    const rows = await db
      .select({ plan: plans, schoolCount: sql<number>`(select count(*)::int from ${schools} where ${schools.planId} = ${plans.id})` })
      .from(plans)
      .orderBy(asc(plans.priceMonthly));
    return ok(rows.map((r) => ({ ...r.plan, schoolCount: r.schoolCount })));
  });

  r.post('/platform/plans', { schema: { tags: ['Platform'], body: planBody } }, async (req) => {
    const [row] = await db.insert(plans).values(req.body).returning();
    return ok(row);
  });

  r.put('/platform/plans/:id', { schema: { tags: ['Platform'], params: idParam, body: planBody } }, async (req) => {
    const [row] = await db.update(plans).set(req.body).where(eq(plans.id, req.params.id)).returning();
    return ok(must(row, 'Plan'));
  });

  r.delete('/platform/plans/:id', { schema: { tags: ['Platform'], params: idParam } }, async (req) => {
    const [{ n }] = await db.select({ n: count() }).from(schools).where(eq(schools.planId, req.params.id));
    if (n > 0) throw conflict(`This plan is used by ${n} school(s). Deactivate it instead.`);
    await db.delete(plans).where(eq(plans.id, req.params.id));
    return ok({ deleted: true });
  });
}
