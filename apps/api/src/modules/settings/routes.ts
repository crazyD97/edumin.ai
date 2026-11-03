/** School settings: branding/white-label and operational settings. */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schools } from '../../db/schema';
import { must } from '../../core/errors';
import { ctxOf, guard, ok, typed, type App } from '../../core/http';
import { audit } from '../../core/audit';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #4f46e5');
const s = z.string().trim().max(500).nullish();

export const brandingBody = z.object({
  name: z.string().trim().min(2).max(200),
  logoUrl: s,
  faviconUrl: s,
  primaryColor: hex,
  secondaryColor: hex,
  accentColor: hex,
  email: z.email().nullish().or(z.literal('').transform(() => null)),
  phone: s,
  address: s,
  website: s,
  loginTitle: s,
  loginSubtitle: s,
  loginImageUrl: s,
  reportCardHeader: s,
  reportCardFooter: s,
  receiptHeader: s,
  receiptFooter: s,
  principalName: s,
});

const settingsBody = z.object({
  admissionNoFormat: z.string().trim().min(1).max(40),
  receiptNoFormat: z.string().trim().min(1).max(40),
  applicationNoFormat: z.string().trim().min(1).max(40),
  lowAttendanceThreshold: z.coerce.number().min(0).max(100),
  currency: z.string().trim().length(3).toUpperCase(),
  timezone: z.string().trim().min(1),
  workingDays: z.array(z.number().int().min(1).max(7)).min(1),
});

export async function settingsRoutes(app: App) {
  const r = typed(app);

  /** Any signed-in school user can read the school profile (for theming). */
  r.get('/school', { schema: { tags: ['Settings'], summary: 'Current school profile, branding and settings' } }, async (req) => {
    const ctx = ctxOf(req);
    const [row] = await ctx.db.select().from(schools).where(eq(schools.id, ctx.schoolId));
    const sc = must(row, 'School');
    return ok({ id: sc.id, name: sc.name, slug: sc.slug, status: sc.status, trialEndsAt: sc.trialEndsAt, branding: sc.branding, settings: sc.settings });
  });

  r.put('/school/branding', { preValidation: guard('settings.edit'), schema: { tags: ['Settings'], body: brandingBody } }, async (req) => {
    const ctx = ctxOf(req);
    const { name, ...branding } = req.body;
    const [row] = await ctx.db.update(schools).set({ name, branding }).where(eq(schools.id, ctx.schoolId)).returning();
    await audit(ctx, 'update', 'branding', ctx.schoolId);
    return ok({ name: row.name, branding: row.branding });
  });

  r.put('/school/settings', { preValidation: guard('settings.edit'), schema: { tags: ['Settings'], body: settingsBody } }, async (req) => {
    const ctx = ctxOf(req);
    const [row] = await ctx.db.update(schools).set({ settings: req.body }).where(eq(schools.id, ctx.schoolId)).returning();
    await audit(ctx, 'update', 'settings', ctx.schoolId);
    return ok(row.settings);
  });
}
