import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { SessionUser } from '@edumin/shared';
import { db } from '../../core/db';
import { schools, users } from '../../db/schema';
import { AUTH_COOKIE, cookieOptions, hashPassword, signToken, verifyPassword } from '../../core/auth';
import { AppError, badRequest, unauthorized } from '../../core/errors';
import { ok, schoolAccessError, typed, type App } from '../../core/http';
import { audit } from '../../core/audit';
import { env } from '../../core/env';

export function sessionUser(a: NonNullable<import('fastify').FastifyRequest['auth']>): SessionUser {
  return {
    id: a.user.id,
    email: a.user.email,
    fullName: a.user.fullName,
    avatarUrl: a.user.avatarUrl,
    isPlatformAdmin: a.user.isPlatformAdmin,
    role: a.role ? { key: a.role.key, name: a.role.name, scope: a.role.scope } : { key: 'platform_admin', name: 'Platform Super Admin', scope: 'platform' },
    permissions: a.role?.permissions ?? [],
    school: a.school ? { id: a.school.id, name: a.school.name, slug: a.school.slug, status: a.school.status, features: a.features } : null,
  };
}

export async function authRoutes(app: App) {
  const r = typed(app);

  r.post(
    '/auth/login',
    {
      config: { rateLimit: { max: env.NODE_ENV === 'test' ? 10_000 : 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Sign in. Omit schoolSlug to sign in as platform admin.',
        body: z.object({ email: z.email(), password: z.string().min(1), schoolSlug: z.string().trim().toLowerCase().optional().nullable() }),
      },
    },
    async (req, reply) => {
      const { email, password, schoolSlug } = req.body;
      let schoolRow: typeof schools.$inferSelect | undefined;
      if (schoolSlug) {
        [schoolRow] = await db.select().from(schools).where(eq(schools.slug, schoolSlug));
        if (!schoolRow) throw unauthorized('School not found');
      }
      const [user] = await db
        .select()
        .from(users)
        .where(and(sql`lower(${users.email}) = ${email.toLowerCase()}`, schoolRow ? eq(users.schoolId, schoolRow.id) : isNull(users.schoolId)));
      if (!user || !(await verifyPassword(password, user.passwordHash))) throw unauthorized('Invalid email or password');
      if (!user.isActive) throw new AppError(403, 'ACCOUNT_DISABLED', 'Your account has been disabled');
      if (schoolRow) {
        const blocked = schoolAccessError(schoolRow);
        if (blocked) throw blocked;
      }
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      const token = signToken({ sub: user.id, sid: user.schoolId, tv: user.tokenVersion });
      reply.setCookie(AUTH_COOKIE, token, cookieOptions);
      await audit({ db, userId: user.id, schoolId: user.schoolId }, 'login', 'user', user.id);
      return ok({ token });
    },
  );

  r.post('/auth/logout', { schema: { tags: ['Auth'] } }, async (_req, reply) => {
    reply.clearCookie(AUTH_COOKIE, { path: '/' });
    return ok({ loggedOut: true });
  });

  r.get('/auth/me', { schema: { tags: ['Auth'], summary: 'Current session user with role, permissions and school features' } }, async (req) => {
    if (!req.auth) throw unauthorized();
    return ok(sessionUser(req.auth));
  });

  r.post(
    '/auth/change-password',
    { schema: { tags: ['Auth'], body: z.object({ currentPassword: z.string(), newPassword: z.string().min(8, 'Use at least 8 characters') }) } },
    async (req, reply) => {
      if (!req.auth) throw unauthorized();
      const u = req.auth.user;
      if (!(await verifyPassword(req.body.currentPassword, u.passwordHash))) throw badRequest('Current password is incorrect');
      const [updated] = await db
        .update(users)
        .set({ passwordHash: await hashPassword(req.body.newPassword), tokenVersion: u.tokenVersion + 1 })
        .where(eq(users.id, u.id))
        .returning();
      reply.setCookie(AUTH_COOKIE, signToken({ sub: u.id, sid: u.schoolId, tv: updated.tokenVersion }), cookieOptions);
      return ok({ changed: true });
    },
  );

  r.patch(
    '/auth/profile',
    { schema: { tags: ['Auth'], body: z.object({ fullName: z.string().trim().min(2).max(200), phone: z.string().trim().max(30).nullish(), avatarUrl: z.string().max(500).nullish() }) } },
    async (req) => {
      if (!req.auth) throw unauthorized();
      await db.update(users).set(req.body).where(eq(users.id, req.auth.user.id));
      return ok({ updated: true });
    },
  );
}
