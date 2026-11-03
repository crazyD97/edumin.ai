/** Announcements (targeted by audience/class) and in-app notifications. */
import { z } from 'zod';
import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { ANNOUNCEMENT_AUDIENCES, ANNOUNCEMENT_CATEGORIES } from '@edumin/shared';
import { announcements, notifications, sections, users } from '../../db/schema';
import { forbidden, must } from '../../core/errors';
import { ctxOf, guard, idParam, ok, pageQuery, typed, type App } from '../../core/http';
import { currentYearId, requirePermission, scopedSectionIds, type Ctx } from '../../core/context';
import { audience, notifyUsers } from '../../core/notify';
import { audit } from '../../core/audit';
import { db } from '../../core/db';

const F = { feature: 'communication' as const };

export const announcementInput = z
  .object({
    title: z.string().trim().min(2).max(200),
    body: z.string().trim().min(1).max(20000),
    category: z.enum(ANNOUNCEMENT_CATEGORIES).default('general'),
    audience: z.enum(ANNOUNCEMENT_AUDIENCES),
    classIds: z.array(z.uuid()).default([]),
    isPinned: z.boolean().default(false),
    sendEmail: z.boolean().default(false),
  })
  .refine((v) => v.audience !== 'classes' || v.classIds.length > 0, { message: 'Choose at least one class', path: ['classIds'] });

/** Resolve recipients for an announcement. */
async function recipientsFor(ctx: Ctx, a: z.infer<typeof announcementInput>) {
  const yearId = await currentYearId(ctx);
  switch (a.audience) {
    case 'all':
      return (await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.schoolId, ctx.schoolId), eq(users.isActive, true)))).map((u) => u.id);
    case 'staff':
      return audience.staff(ctx.db, ctx.schoolId);
    case 'students':
      return audience.byRoleKeys(ctx.db, ctx.schoolId, ['student']);
    case 'parents':
      return audience.byRoleKeys(ctx.db, ctx.schoolId, ['parent']);
    case 'classes': {
      const studs = await audience.studentsInClasses(ctx.db, ctx.schoolId, a.classIds, yearId);
      const people = await audience.forStudents(ctx.db, ctx.schoolId, studs);
      const teachers = await ctx.db
        .select({ id: sections.classTeacherId })
        .from(sections)
        .where(and(eq(sections.schoolId, ctx.schoolId), inArray(sections.classId, a.classIds), yearId ? eq(sections.academicYearId, yearId) : undefined));
      return [...people, ...teachers.map((t) => t.id!).filter(Boolean)];
    }
  }
}

/** Announcement visibility filter for the caller. */
async function visibleWhere(ctx: Ctx) {
  const base = eq(announcements.schoolId, ctx.schoolId);
  if (ctx.scope === 'school') return base;
  const role = ctx.roleKey;
  const audiences = role === 'student' ? ['all', 'students'] : role === 'parent' ? ['all', 'parents'] : ['all', 'staff'];
  const secIds = (await scopedSectionIds(ctx)) ?? [];
  const classIds = secIds.length ? (await ctx.db.selectDistinct({ id: sections.classId }).from(sections).where(inArray(sections.id, secIds))).map((r) => r.id) : [];
  const classMatch = classIds.length ? sql`(${announcements.audience} = 'classes' and ${announcements.classIds} ?| array[${sql.join(classIds.map((c) => sql`${c}`), sql`,`)}]::text[])` : sql`false`;
  return and(base, or(inArray(announcements.audience, audiences), classMatch, eq(announcements.createdBy, ctx.userId)));
}

export async function listAnnouncements(ctx: Ctx, q: { page: number; pageSize: number; search?: string; category?: string }) {
  requirePermission(ctx, 'announcements.view');
  const where = and(
    await visibleWhere(ctx),
    q.category ? eq(announcements.category, q.category) : undefined,
    q.search ? sql`(${announcements.title} ilike ${'%' + q.search + '%'} or ${announcements.body} ilike ${'%' + q.search + '%'})` : undefined,
  );
  const rows = await ctx.db
    .select({ a: announcements, authorName: users.fullName })
    .from(announcements)
    .leftJoin(users, eq(users.id, announcements.createdBy))
    .where(where)
    .orderBy(desc(announcements.isPinned), desc(announcements.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [{ n }] = await ctx.db.select({ n: count() }).from(announcements).where(where);
  return { rows: rows.map((r) => ({ ...r.a, authorName: r.authorName })), total: n };
}

export async function createAnnouncement(ctx: Ctx, v: z.infer<typeof announcementInput>) {
  requirePermission(ctx, 'announcements.create');
  // Teachers may only address classes they teach.
  if (ctx.scope !== 'school') {
    if (v.audience !== 'classes') throw forbidden('You can only post announcements to your own classes');
    const secs = (await scopedSectionIds(ctx)) ?? [];
    const allowed = new Set((await ctx.db.selectDistinct({ id: sections.classId }).from(sections).where(inArray(sections.id, secs.length ? secs : ['00000000-0000-0000-0000-000000000000']))).map((r) => r.id));
    if (v.classIds.some((c) => !allowed.has(c))) throw forbidden('You can only post to classes you teach');
  }
  const [row] = await ctx.db.insert(announcements).values({ ...v, schoolId: ctx.schoolId, createdBy: ctx.userId }).returning();
  const recipients = (await recipientsFor(ctx, v)).filter((id) => id !== ctx.userId);
  await notifyUsers(ctx.db, ctx.schoolId, recipients, { type: `announcement_${v.category}`, title: v.title, body: v.body.slice(0, 280), link: `/announcements?id=${row.id}`, email: v.sendEmail });
  await audit(ctx, 'create', 'announcement', row.id, { recipients: recipients.length });
  return { ...row, recipients: recipients.length };
}

export async function communicationRoutes(app: App) {
  const r = typed(app);

  r.get(
    '/announcements',
    { preValidation: guard('announcements.view', F), schema: { tags: ['Communication'], querystring: pageQuery.extend({ category: z.enum(ANNOUNCEMENT_CATEGORIES).optional() }) } },
    async (req) => {
      const res = await listAnnouncements(ctxOf(req), req.query);
      return ok(res.rows, { page: req.query.page, pageSize: req.query.pageSize, total: res.total });
    },
  );
  r.post('/announcements', { preValidation: guard('announcements.create', F), schema: { tags: ['Communication'], body: announcementInput } }, async (req) => ok(await createAnnouncement(ctxOf(req), req.body)));
  r.patch('/announcements/:id', { preValidation: guard('announcements.edit', F), schema: { tags: ['Communication'], params: idParam, body: z.object({ isPinned: z.boolean() }) } }, async (req) => {
    const ctx = ctxOf(req);
    const [row] = await ctx.db.update(announcements).set(req.body).where(and(eq(announcements.id, req.params.id), eq(announcements.schoolId, ctx.schoolId))).returning();
    return ok(must(row, 'Announcement'));
  });
  r.delete('/announcements/:id', { preValidation: guard(undefined, F), schema: { tags: ['Communication'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    const [a] = await ctx.db.select().from(announcements).where(and(eq(announcements.id, req.params.id), eq(announcements.schoolId, ctx.schoolId)));
    must(a, 'Announcement');
    if (a.createdBy !== ctx.userId) requirePermission(ctx, 'announcements.delete');
    await ctx.db.delete(announcements).where(eq(announcements.id, a.id));
    return ok({ deleted: true });
  });

  // ── Notifications (every signed-in user, including platform admins) ──
  const userId = (req: Parameters<typeof ctxOf>[0]) => {
    if (!req.auth) throw forbidden();
    return req.auth.user.id;
  };
  r.get('/notifications', { schema: { tags: ['Notifications'], querystring: z.object({ unread: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }) } }, async (req) => {
    const uid = userId(req);
    const rows = await db.select()
      .from(notifications)
      .where(and(eq(notifications.userId, uid), req.query.unread === 'true' ? isNull(notifications.readAt) : undefined))
      .orderBy(desc(notifications.createdAt))
      .limit(req.query.limit);
    const [{ n }] = await db.select({ n: count() }).from(notifications).where(and(eq(notifications.userId, uid), isNull(notifications.readAt)));
    return { ...ok(rows), unreadCount: n };
  });
  r.post('/notifications/read', { schema: { tags: ['Notifications'], body: z.object({ ids: z.array(z.uuid()).optional() }) } }, async (req) => {
    const uid = userId(req);
    await db.update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, uid), isNull(notifications.readAt), req.body.ids?.length ? inArray(notifications.id, req.body.ids) : undefined));
    return ok({ read: true });
  });

  /** Recipients preview for the composer. */
  r.post('/announcements/preview-recipients', { preValidation: guard('announcements.create', F), schema: { tags: ['Communication'], body: announcementInput } }, async (req) => {
    const ctx = ctxOf(req);
    return ok({ count: (await recipientsFor(ctx, req.body)).length });
  });

}
