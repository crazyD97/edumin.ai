/** A school's own third-party accounts. Today: Razorpay for online fee collection. */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { schoolIntegrations } from '../../db/schema';
import { publicUrl } from '../../core/env';
import { badRequest } from '../../core/errors';
import { ctxOf, guard, ok, typed, type App } from '../../core/http';
import { decryptJson, encryptJson } from '../../core/crypto';
import { checkKeys } from '../../core/razorpay';
import { audit } from '../../core/audit';
import type { Ctx } from '../../core/context';

async function razorpayRow(ctx: Ctx) {
  const [row] = await ctx.db.select().from(schoolIntegrations).where(and(eq(schoolIntegrations.schoolId, ctx.schoolId), eq(schoolIntegrations.provider, 'razorpay')));
  return row ?? null;
}

async function describe(ctx: Ctx) {
  const row = await razorpayRow(ctx);
  const secrets = decryptJson<{ keySecret?: string; webhookSecret?: string }>(row?.secrets);
  return [
    {
      provider: 'razorpay',
      enabled: row?.enabled ?? false,
      keyId: row?.config.keyId ?? null,
      mode: row?.config.keyId?.startsWith('rzp_live_') ? 'live' : row?.config.keyId ? 'test' : null,
      hasKeySecret: !!secrets?.keySecret,
      hasWebhookSecret: !!secrets?.webhookSecret,
      webhookUrl: `${publicUrl()}/api/webhooks/razorpay/school/${ctx.schoolId}`,
      featureEnabled: ctx.features.has('online_payments'),
    },
  ];
}

export async function integrationRoutes(app: App) {
  const r = typed(app);

  r.get('/integrations', { preValidation: guard('settings.view'), schema: { tags: ['Integrations'] } }, async (req) => ok(await describe(ctxOf(req))));

  r.put(
    '/integrations/razorpay',
    {
      preValidation: guard('settings.edit'),
      schema: {
        tags: ['Integrations'],
        summary: "Connect the school's Razorpay account. Secrets are stored encrypted and never returned.",
        body: z.object({
          enabled: z.boolean(),
          keyId: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, 'Key ID looks like rzp_live_… or rzp_test_…'),
          keySecret: z.string().trim().min(8).optional(),
          webhookSecret: z.string().trim().min(6).optional(),
        }),
      },
    },
    async (req) => {
      const ctx = ctxOf(req);
      if (req.body.enabled && !ctx.features.has('online_payments')) throw badRequest('Online payments are not included in your plan');
      const row = await razorpayRow(ctx);
      const secrets = { ...(decryptJson<Record<string, string>>(row?.secrets) ?? {}) };
      if (req.body.keySecret) secrets.keySecret = req.body.keySecret;
      if (req.body.webhookSecret) secrets.webhookSecret = req.body.webhookSecret;
      if (req.body.enabled && !secrets.keySecret) throw badRequest('Enter the Key Secret to turn on online payments');
      const values = { enabled: req.body.enabled, config: { keyId: req.body.keyId }, secrets: encryptJson(secrets) };
      await ctx.db
        .insert(schoolIntegrations)
        .values({ schoolId: ctx.schoolId, provider: 'razorpay', ...values })
        .onConflictDoUpdate({ target: [schoolIntegrations.schoolId, schoolIntegrations.provider], set: values });
      await audit(ctx, 'update', 'integration', 'razorpay', { enabled: req.body.enabled, keyId: req.body.keyId });
      return ok(await describe(ctx));
    },
  );

  r.post('/integrations/razorpay/verify', { preValidation: guard('settings.edit'), schema: { tags: ['Integrations'], summary: 'Check the saved keys with Razorpay (no charge)' } }, async (req) => {
    const ctx = ctxOf(req);
    const row = await razorpayRow(ctx);
    const secrets = decryptJson<{ keySecret?: string }>(row?.secrets);
    if (!row?.config.keyId || !secrets?.keySecret) throw badRequest('Save your keys first');
    let valid = false;
    try {
      valid = await checkKeys({ keyId: row.config.keyId, keySecret: secrets.keySecret });
    } catch {
      throw badRequest('Could not reach Razorpay. Check the server’s internet connection.');
    }
    if (!valid) throw badRequest('Razorpay rejected these keys');
    return ok({ valid: true });
  });
}
