/** Installed-app support: per-school web manifest and Web Push subscriptions. */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { pushSubscriptions, schools } from '../../db/schema';
import { db } from '../../core/db';
import { env } from '../../core/env';
import { unauthorized } from '../../core/errors';
import { ok, typed, type App } from '../../core/http';
import { pushEnabled, pushToUsers } from '../../core/push';

async function schoolFor(host: string | undefined, slug: string | undefined) {
  let s = slug?.toLowerCase();
  if (!s && host) {
    const h = host.split(':')[0].toLowerCase();
    const root = env.ROOT_DOMAIN.toLowerCase();
    if (h.endsWith('.' + root)) s = h.slice(0, -(root.length + 1));
  }
  if (!s) return null;
  const [row] = await db.select({ name: schools.name, slug: schools.slug, branding: schools.branding }).from(schools).where(eq(schools.slug, s));
  return row ?? null;
}

export async function pushRoutes(app: App) {
  const r = typed(app);

  /** Web app manifest, named and coloured for the school (from subdomain or ?school=). */
  r.get('/public/manifest.webmanifest', { schema: { hide: true, querystring: z.object({ school: z.string().optional() }) } }, async (req, reply) => {
    const school = await schoolFor((req.headers['x-forwarded-host'] as string) ?? req.headers.host, req.query.school);
    const name = school?.name ?? 'Edumin School';
    const color = school?.branding.primaryColor ?? '#4f46e5';
    const short = name.length > 12 ? name.split(/\s+/).map((w) => w[0]).join('').slice(0, 6) : name;
    return reply.type('application/manifest+json').send({
      name,
      short_name: short,
      description: `${name} — attendance, fees, results and updates`,
      id: school ? `/?school=${school.slug}` : '/',
      start_url: school ? `/?school=${school.slug}` : '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f8fafc',
      theme_color: color,
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      shortcuts: [
        { name: 'Attendance', url: '/attendance' },
        { name: 'Fees', url: '/fees' },
        { name: 'Homework', url: '/homework' },
      ],
    });
  });

  r.get('/push/public-key', { schema: { tags: ['Push'] } }, async () => ok({ enabled: pushEnabled(), publicKey: pushEnabled() ? env.VAPID_PUBLIC_KEY! : null }));

  r.post(
    '/push/subscribe',
    { schema: { tags: ['Push'], body: z.object({ endpoint: z.url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }) } },
    async (req) => {
      if (!req.auth) throw unauthorized();
      const ua = String(req.headers['user-agent'] ?? '').slice(0, 250);
      await db
        .insert(pushSubscriptions)
        .values({ userId: req.auth.user.id, endpoint: req.body.endpoint, p256dh: req.body.keys.p256dh, auth: req.body.keys.auth, userAgent: ua })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: req.auth.user.id, p256dh: req.body.keys.p256dh, auth: req.body.keys.auth, userAgent: ua } });
      return ok({ subscribed: true });
    },
  );

  r.post('/push/unsubscribe', { schema: { tags: ['Push'], body: z.object({ endpoint: z.string() }) } }, async (req) => {
    if (!req.auth) throw unauthorized();
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, req.body.endpoint));
    return ok({ unsubscribed: true });
  });

  r.post('/push/test', { schema: { tags: ['Push'] } }, async (req) => {
    if (!req.auth) throw unauthorized();
    await pushToUsers([req.auth.user.id], { title: 'Notifications are on', body: "You'll get alerts for attendance, fees, results and announcements here.", link: '/notifications' });
    return ok({ sent: true });
  });
}
