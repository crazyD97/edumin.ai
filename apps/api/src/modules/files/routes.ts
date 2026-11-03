/**
 * Uploads and downloads. Files are tied to an entity (student, application,
 * assignment, submission, branding) and always namespaced by school.
 */
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { admissionApplications, assignments, files, schools, submissions } from '../../db/schema';
import { db } from '../../core/db';
import { badRequest, forbidden, must, unauthorized } from '../../core/errors';
import { ctxOf, idParam, ok, typed, type App } from '../../core/http';
import { ALLOWED_MIME, MAX_FILE_BYTES, makeKey, storage } from '../../core/storage';
import { assertStudentAccess, can, scopedSectionIds, type Ctx } from '../../core/context';
import { env } from '../../core/env';

const ENTITIES = ['student', 'application', 'assignment', 'submission', 'branding', 'avatar'] as const;
type Entity = (typeof ENTITIES)[number];

/** Who may attach to / read files of an entity. */
async function checkEntityAccess(ctx: Ctx, entity: Entity | null, entityId: string | null, mode: 'read' | 'write') {
  if (!entity || entity === 'branding' || entity === 'avatar') {
    if (entity === 'branding' && mode === 'write' && !can(ctx, 'settings.edit')) throw forbidden();
    return;
  }
  if (!entityId) throw badRequest('entityId is required');
  switch (entity) {
    case 'student':
      if (mode === 'write' && !can(ctx, 'students.edit')) throw forbidden();
      return assertStudentAccess(ctx, entityId);
    case 'application':
      if (!can(ctx, mode === 'write' ? 'admissions.edit' : 'admissions.view')) throw forbidden();
      must((await ctx.db.select({ id: admissionApplications.id }).from(admissionApplications).where(and(eq(admissionApplications.id, entityId), eq(admissionApplications.schoolId, ctx.schoolId))))[0], 'Application');
      return;
    case 'assignment': {
      const [a] = await ctx.db.select().from(assignments).where(and(eq(assignments.id, entityId), eq(assignments.schoolId, ctx.schoolId)));
      must(a, 'Assignment');
      if (mode === 'write' && !can(ctx, 'homework.edit')) throw forbidden();
      const secs = await scopedSectionIds(ctx);
      if (secs && !secs.includes(a.sectionId)) throw forbidden();
      return;
    }
    case 'submission': {
      const [s] = await ctx.db.select().from(submissions).where(and(eq(submissions.id, entityId), eq(submissions.schoolId, ctx.schoolId)));
      must(s, 'Submission');
      return assertStudentAccess(ctx, s.studentId);
    }
  }
}

async function readUpload(req: import('fastify').FastifyRequest) {
  const part = await req.file({ limits: { fileSize: MAX_FILE_BYTES } });
  if (!part) throw badRequest('No file uploaded');
  if (!ALLOWED_MIME.includes(part.mimetype)) throw badRequest(`File type ${part.mimetype} is not allowed`);
  const buf = await part.toBuffer();
  if (part.file.truncated) throw badRequest('File is larger than 10 MB');
  const field = (name: string) => {
    const f = part.fields[name] as { value?: string } | undefined;
    return f?.value ? String(f.value) : null;
  };
  return { part, buf, field };
}

/** Short-lived token letting an applicant attach documents to their just-submitted application. */
export function applicationUploadToken(schoolId: string, applicationId: string) {
  return jwt.sign({ sid: schoolId, aid: applicationId, k: 'app-upload' }, env.JWT_SECRET, { expiresIn: '2h' });
}

export async function fileRoutes(app: App) {
  const r = typed(app);

  r.post('/files', { schema: { tags: ['Files'], summary: 'multipart: file, entity, entityId, category' } }, async (req) => {
    const ctx = ctxOf(req);
    const { part, buf, field } = await readUpload(req);
    const entity = field('entity') as Entity | null;
    if (entity && !ENTITIES.includes(entity)) throw badRequest('Invalid entity');
    const entityId = field('entityId');
    await checkEntityAccess(ctx, entity, entityId, 'write');
    const key = makeKey(ctx.schoolId, part.filename);
    await storage.put(key, buf);
    const [row] = await ctx.db
      .insert(files)
      .values({
        schoolId: ctx.schoolId,
        uploadedBy: ctx.userId,
        entity,
        entityId,
        category: field('category'),
        filename: part.filename,
        mimeType: part.mimetype,
        size: buf.length,
        storageKey: key,
        isPublic: entity === 'branding' || entity === 'avatar',
      })
      .returning();
    return ok({ ...row, url: `/api/files/${row.id}` });
  });

  r.post(
    '/public/applications/:id/documents',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { tags: ['Public'], params: idParam, querystring: z.object({ token: z.string() }) } },
    async (req) => {
      let payload: { sid: string; aid: string; k: string };
      try {
        payload = jwt.verify(req.query.token, env.JWT_SECRET) as typeof payload;
      } catch {
        throw unauthorized('Upload link expired');
      }
      if (payload.k !== 'app-upload' || payload.aid !== req.params.id) throw unauthorized();
      const { part, buf, field } = await readUpload(req);
      const key = makeKey(payload.sid, part.filename);
      await storage.put(key, buf);
      const [row] = await db
        .insert(files)
        .values({ schoolId: payload.sid, entity: 'application', entityId: payload.aid, category: field('category'), filename: part.filename, mimeType: part.mimetype, size: buf.length, storageKey: key })
        .returning({ id: files.id });
      return ok(row);
    },
  );

  r.get(
    '/files',
    { schema: { tags: ['Files'], querystring: z.object({ entity: z.enum(ENTITIES), entityId: z.uuid() }) } },
    async (req) => {
      const ctx = ctxOf(req);
      await checkEntityAccess(ctx, req.query.entity, req.query.entityId, 'read');
      const rows = await ctx.db
        .select({ id: files.id, filename: files.filename, mimeType: files.mimeType, size: files.size, category: files.category, createdAt: files.createdAt })
        .from(files)
        .where(and(eq(files.schoolId, ctx.schoolId), eq(files.entity, req.query.entity), eq(files.entityId, req.query.entityId)))
        .orderBy(desc(files.createdAt));
      return ok(rows.map((f) => ({ ...f, url: `/api/files/${f.id}` })));
    },
  );

  /** Public files (logos, favicons, avatars) need no auth; everything else is checked. */
  r.get('/files/:id', { schema: { tags: ['Files'], params: idParam } }, async (req, reply) => {
    const [f] = await db.select().from(files).where(eq(files.id, req.params.id));
    must(f, 'File');
    if (!f.isPublic) {
      const ctx = ctxOf(req);
      if (f.schoolId !== ctx.schoolId) throw must(null, 'File');
      await checkEntityAccess(ctx, f.entity as Entity, f.entityId, 'read');
    } else if (f.schoolId) {
      const [s] = await db.select({ status: schools.status }).from(schools).where(eq(schools.id, f.schoolId));
      if (!s) throw must(null, 'File');
    }
    const buf = await storage.get(f.storageKey);
    reply.header('Content-Type', f.mimeType).header('Cache-Control', f.isPublic ? 'public, max-age=86400' : 'private, no-store');
    if (f.mimeType === 'image/svg+xml') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    if (!f.mimeType.startsWith('image/') && f.mimeType !== 'application/pdf') {
      reply.header('Content-Disposition', `attachment; filename="${f.filename.replace(/[^\w.\- ]/g, '_')}"`);
    }
    return reply.send(buf);
  });

  r.delete('/files/:id', { schema: { tags: ['Files'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    const [f] = await ctx.db.select().from(files).where(and(eq(files.id, req.params.id), eq(files.schoolId, ctx.schoolId)));
    must(f, 'File');
    if (f.uploadedBy !== ctx.userId) await checkEntityAccess(ctx, f.entity as Entity, f.entityId, 'write');
    await ctx.db.delete(files).where(eq(files.id, f.id));
    await storage.remove(f.storageKey);
    return ok({ deleted: true });
  });
}
