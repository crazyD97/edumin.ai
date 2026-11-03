/**
 * HTTP plumbing: auth resolution, the response envelope, error mapping and
 * small helpers shared by every route module.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { hasZodFastifySchemaValidationErrors, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { FeatureKey, Permission, DataScope } from '@edumin/shared';
import { ALL_FEATURES } from '@edumin/shared';
import { AUTH_COOKIE, verifyToken } from './auth';
import { db } from './db';
import { plans, roles, schools, users } from '../db/schema';
import { AppError, forbidden, unauthorized } from './errors';
import { createCtx, requireFeature, requirePermission, type Ctx, type PlatformCtx } from './context';

export interface AuthState {
  user: typeof users.$inferSelect;
  role: typeof roles.$inferSelect | null;
  school: typeof schools.$inferSelect | null;
  features: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthState | null;
  }
}

export const ok = <T>(data: T, meta?: { page: number; pageSize: number; total: number }) => ({ success: true as const, data, ...(meta ? { meta } : {}) });

/** Effective features = plan features overlaid with per-school overrides. */
export function effectiveFeatures(school: typeof schools.$inferSelect, plan: typeof plans.$inferSelect | null): string[] {
  const base = new Set<string>(plan ? plan.features : ALL_FEATURES);
  for (const [k, v] of Object.entries(school.featureOverrides ?? {})) v ? base.add(k) : base.delete(k);
  return [...base];
}

async function resolveAuth(req: FastifyRequest): Promise<AuthState | null> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.[AUTH_COOKIE];
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const [row] = await db
    .select({ user: users, role: roles, school: schools, plan: plans })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.roleId))
    .leftJoin(schools, eq(schools.id, users.schoolId))
    .leftJoin(plans, eq(plans.id, schools.planId))
    .where(eq(users.id, payload.sub))
    .limit(1);
  if (!row || !row.user.isActive || row.user.tokenVersion !== payload.tv) return null;
  return {
    user: row.user,
    role: row.role,
    school: row.school,
    features: row.school ? effectiveFeatures(row.school, row.plan) : [],
  };
}

export function schoolAccessError(school: typeof schools.$inferSelect): AppError | null {
  if (school.status === 'suspended') return new AppError(403, 'SCHOOL_SUSPENDED', 'This school account is suspended. Please contact support.');
  if (school.status === 'cancelled') return new AppError(403, 'SCHOOL_CANCELLED', 'This school account has been closed.');
  if (school.status === 'trial' && school.trialEndsAt && school.trialEndsAt < new Date()) {
    return new AppError(403, 'TRIAL_EXPIRED', 'Your trial period has ended. Please contact us to activate your subscription.');
  }
  return null;
}

export const httpPlugin = fp(async (app: FastifyInstance, opts: { spaIndexHtml?: string | null }) => {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = await resolveAuth(req);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Some fields are invalid',
          details: err.validation.map((v: any) => ({ path: (v.instancePath || '').replace(/^\//, '').replaceAll('/', '.'), message: v.message })),
        },
      });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Some fields are invalid', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    if (err instanceof AppError) {
      return reply.status(err.status).send({ success: false, error: { code: err.code, message: err.message, details: err.details } });
    }
    // Postgres unique violation → 409
    const pg = err?.cause ?? err;
    if (pg?.code === '23505') {
      return reply.status(409).send({ success: false, error: { code: 'CONFLICT', message: 'A record with these details already exists', details: pg.detail } });
    }
    if (pg?.code === '23503') {
      return reply.status(409).send({ success: false, error: { code: 'IN_USE', message: 'This record is referenced by other data and cannot be changed or removed' } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ success: false, error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error(err);
    return reply.status(500).send({ success: false, error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
  });

  app.setNotFoundHandler((req, reply) => {
    // In production the API also serves the web app; unknown non-API paths are client routes.
    if (opts.spaIndexHtml && req.method === 'GET' && !req.url.startsWith('/api')) return reply.type('text/html').send(opts.spaIndexHtml);
    reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` } });
  });
});

/** Build the service context for a school-user request, enforcing tenant status. */
export function ctxOf(req: FastifyRequest): Ctx {
  const a = req.auth;
  if (!a) throw unauthorized();
  if (!a.school || !a.role) throw forbidden('This endpoint is only available to school users');
  const blocked = schoolAccessError(a.school);
  if (blocked) throw blocked;
  return createCtx({
    userId: a.user.id,
    schoolId: a.school.id,
    roleKey: a.role.key,
    scope: a.role.scope as DataScope,
    permissions: new Set(a.role.permissions),
    features: new Set(a.features),
  });
}

export function platformCtxOf(req: FastifyRequest): PlatformCtx {
  const a = req.auth;
  if (!a) throw unauthorized();
  if (!a.user.isPlatformAdmin) throw forbidden('Platform administrator access required');
  return { db, userId: a.user.id };
}

/** Route-level guard: `preValidation: guard('students.view', { feature: 'fees' })`. */
export function guard(perm?: Permission | Permission[], opts: { feature?: FeatureKey } = {}) {
  return async (req: FastifyRequest) => {
    const ctx = ctxOf(req);
    if (opts.feature) requireFeature(ctx, opts.feature);
    if (perm) requirePermission(ctx, ...(Array.isArray(perm) ? perm : [perm]));
  };
}

export type App = FastifyInstance;
export const typed = (app: FastifyInstance) => app.withTypeProvider<ZodTypeProvider>();

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
  search: z.string().trim().optional(),
});
export type PageQuery = z.infer<typeof pageQuery>;

export const idParam = z.object({ id: z.uuid() });

/** Sends a binary download (PDF, XLSX, CSV). */
export function sendFile(reply: FastifyReply, buf: Buffer | string, filename: string, mime: string) {
  return reply
    .header('Content-Type', mime)
    .header('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\- ]/g, '_')}"`)
    .send(buf);
}

/** Empty strings from forms become null/undefined. */
export const optStr = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .nullish();
export const optDate = z
  .union([z.iso.date(), z.literal('')])
  .transform((v) => (v === '' ? null : v))
  .nullish();
export const optUuid = z
  .union([z.uuid(), z.literal('')])
  .transform((v) => (v === '' ? null : v))
  .nullish();
