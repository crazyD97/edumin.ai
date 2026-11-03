/**
 * Unauthenticated endpoints: tenant lookup for the login page, and the
 * online admission enquiry / application forms.
 */
import { z } from 'zod';
import { eq, and, asc } from 'drizzle-orm';
import { db } from '../../core/db';
import { academicYears, classes, schools } from '../../db/schema';
import { notFound } from '../../core/errors';
import { ok, typed, type App } from '../../core/http';
import { env } from '../../core/env';
import { applicationUploadToken } from '../files/routes';
import { submitApplication, submitEnquiry, applicationInput, enquiryInput } from '../admissions/service';

async function schoolBySlug(slug: string) {
  const [s] = await db.select().from(schools).where(eq(schools.slug, slug.toLowerCase()));
  if (!s || s.status === 'cancelled') throw notFound('School');
  return s;
}

export async function publicRoutes(app: App) {
  const r = typed(app);

  /** Resolve a school from a hostname like `greenwood.edumin.localhost`. */
  r.get('/public/resolve', { schema: { tags: ['Public'], querystring: z.object({ host: z.string() }) } }, async (req) => {
    const host = req.query.host.split(':')[0].toLowerCase();
    const root = env.ROOT_DOMAIN.toLowerCase();
    const slug = host.endsWith('.' + root) ? host.slice(0, -(root.length + 1)) : null;
    if (!slug || slug === 'www' || slug === 'app') return ok(null);
    const [s] = await db.select({ slug: schools.slug }).from(schools).where(eq(schools.slug, slug));
    return ok(s ? { slug: s.slug } : null);
  });

  r.get('/public/schools/:slug', { schema: { tags: ['Public'], params: z.object({ slug: z.string() }) } }, async (req) => {
    const s = await schoolBySlug(req.params.slug);
    const b = s.branding;
    return ok({
      name: s.name,
      slug: s.slug,
      status: s.status,
      branding: {
        logoUrl: b.logoUrl,
        faviconUrl: b.faviconUrl,
        primaryColor: b.primaryColor,
        secondaryColor: b.secondaryColor,
        accentColor: b.accentColor,
        loginTitle: b.loginTitle,
        loginSubtitle: b.loginSubtitle,
        loginImageUrl: b.loginImageUrl,
        email: b.email,
        phone: b.phone,
        address: b.address,
        website: b.website,
      },
    });
  });

  r.get('/public/schools/:slug/classes', { schema: { tags: ['Public'], params: z.object({ slug: z.string() }) } }, async (req) => {
    const s = await schoolBySlug(req.params.slug);
    const rows = await db.select({ id: classes.id, name: classes.name }).from(classes).where(eq(classes.schoolId, s.id)).orderBy(asc(classes.level));
    const [year] = await db
      .select({ id: academicYears.id, name: academicYears.name })
      .from(academicYears)
      .where(and(eq(academicYears.schoolId, s.id), eq(academicYears.isCurrent, true)));
    return ok({ classes: rows, academicYear: year ?? null });
  });

  r.post(
    '/public/schools/:slug/enquiries',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['Public'], params: z.object({ slug: z.string() }), body: enquiryInput } },
    async (req) => {
      const s = await schoolBySlug(req.params.slug);
      const row = await submitEnquiry(db, s.id, { ...req.body, source: 'website' });
      return ok({ id: row.id });
    },
  );

  r.post(
    '/public/schools/:slug/applications',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['Public'], params: z.object({ slug: z.string() }), body: applicationInput } },
    async (req) => {
      const s = await schoolBySlug(req.params.slug);
      const row = await submitApplication(db, s.id, req.body);
      return ok({ id: row.id, applicationNo: row.applicationNo, uploadToken: applicationUploadToken(s.id, row.id) });
    },
  );
}
