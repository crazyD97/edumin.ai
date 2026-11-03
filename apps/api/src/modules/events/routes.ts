/** School events, holidays and the unified calendar (events + exams + meetings). */
import { z } from 'zod';
import { and, asc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { EVENT_TYPES } from '@edumin/shared';
import { classes, events, examPapers, exams, meetings, sections, subjects } from '../../db/schema';
import { badRequest, must } from '../../core/errors';
import { ctxOf, guard, idParam, ok, typed, type App } from '../../core/http';
import { currentYearId, ownStudentIds, scopedSectionIds, type Ctx } from '../../core/context';
import { audience, notifyUsers } from '../../core/notify';

const F = { feature: 'events' as const };

export const eventInput = z
  .object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(5000).nullish(),
    type: z.enum(EVENT_TYPES),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    startTime: z.string().regex(/^\d{2}:\d{2}/).nullish().or(z.literal('').transform(() => null)),
    endTime: z.string().regex(/^\d{2}:\d{2}/).nullish().or(z.literal('').transform(() => null)),
    location: z.string().trim().max(150).nullish(),
    classIds: z.array(z.uuid()).default([]),
    announce: z.boolean().default(false),
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'End date must be on or after start date', path: ['endDate'] });

/** Class ids relevant to the caller, or null for "everything". */
async function myClassIds(ctx: Ctx) {
  const secs = await scopedSectionIds(ctx);
  if (!secs) return null;
  if (!secs.length) return [];
  return (await ctx.db.selectDistinct({ id: sections.classId }).from(sections).where(inArray(sections.id, secs))).map((r) => r.id);
}

export async function listEvents(ctx: Ctx, from: string, to: string) {
  const mine = await myClassIds(ctx);
  const visible = mine === null ? undefined : or(sql`jsonb_array_length(${events.classIds}) = 0`, mine.length ? sql`${events.classIds} ?| array[${sql.join(mine.map((c) => sql`${c}`), sql`,`)}]::text[]` : sql`false`);
  return ctx.db
    .select()
    .from(events)
    .where(and(eq(events.schoolId, ctx.schoolId), lte(events.startDate, to), gte(events.endDate, from), visible))
    .orderBy(asc(events.startDate));
}

/** Unified calendar items for a date range. */
export async function calendar(ctx: Ctx, from: string, to: string) {
  const items: { id: string; title: string; type: string; startDate: string; endDate: string; time?: string | null; link?: string; description?: string | null; location?: string | null }[] = [];
  if (ctx.features.has('events') && ctx.permissions.has('events.view')) {
    for (const e of await listEvents(ctx, from, to)) items.push({ id: e.id, title: e.title, type: e.type, startDate: e.startDate, endDate: e.endDate, time: e.startTime, description: e.description, location: e.location });
  }
  if (ctx.features.has('exams') && ctx.permissions.has('exams.view')) {
    const mine = await myClassIds(ctx);
    if (mine === null || mine.length) {
      const papers = await ctx.db
        .select({ id: examPapers.id, date: examPapers.date, time: examPapers.startTime, examName: exams.name, subject: subjects.name, className: classes.name, examId: exams.id })
        .from(examPapers)
        .innerJoin(exams, eq(exams.id, examPapers.examId))
        .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
        .innerJoin(classes, eq(classes.id, examPapers.classId))
        .where(and(eq(examPapers.schoolId, ctx.schoolId), sql`${exams.status} <> 'draft'`, gte(examPapers.date, from), lte(examPapers.date, to), mine ? inArray(examPapers.classId, mine) : undefined));
      // Collapse to one item per exam per day for admins; per paper for students.
      const byKey = new Map<string, (typeof items)[number]>();
      for (const p of papers) {
        const key = mine && mine.length <= 2 ? p.id : `${p.examId}|${p.date}`;
        if (!byKey.has(key))
          byKey.set(key, { id: key, title: mine && mine.length <= 2 ? `${p.examName}: ${p.subject}` : p.examName, type: 'exam', startDate: p.date!, endDate: p.date!, time: p.time, link: `/exams/${p.examId}` });
      }
      items.push(...byKey.values());
    }
  }
  if (ctx.features.has('meetings') && ctx.permissions.has('meetings.view') && ctx.scope !== 'school') {
    const own = ctx.scope === 'own' ? await ownStudentIds(ctx) : [];
    const ms = await ctx.db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.schoolId, ctx.schoolId),
          inArray(meetings.status, ['approved', 'requested']),
          sql`${meetings.startsAt}::date between ${from} and ${to}`,
          ctx.scope === 'assigned' ? eq(meetings.teacherId, ctx.userId) : or(eq(meetings.parentUserId, ctx.userId), own.length ? inArray(meetings.studentId, own) : sql`false`),
        ),
      );
    for (const m of ms) {
      const d = m.startsAt.toISOString().slice(0, 10);
      items.push({ id: m.id, title: 'Parent–teacher meeting', type: 'ptm', startDate: d, endDate: d, time: m.startsAt.toTimeString().slice(0, 5), link: '/meetings', location: m.location });
    }
  }
  return items.sort((a, b) => a.startDate.localeCompare(b.startDate) || String(a.time ?? '').localeCompare(String(b.time ?? '')));
}

async function announceEvent(ctx: Ctx, e: typeof events.$inferSelect) {
  let recipients: string[];
  if (e.classIds.length) {
    const studs = await audience.studentsInClasses(ctx.db, ctx.schoolId, e.classIds, await currentYearId(ctx));
    recipients = await audience.forStudents(ctx.db, ctx.schoolId, studs);
  } else {
    recipients = (await ctx.db.execute<{ id: string }>(sql`select id from users where school_id = ${ctx.schoolId} and is_active`)).map((r) => r.id);
  }
  const when = e.startDate === e.endDate ? e.startDate : `${e.startDate} → ${e.endDate}`;
  await notifyUsers(ctx.db, ctx.schoolId, recipients.filter((r) => r !== ctx.userId), { type: `event_${e.type}`, title: e.type === 'holiday' ? `Holiday: ${e.title}` : e.title, body: `${when}${e.location ? ' · ' + e.location : ''}`, link: '/calendar' });
}

export async function eventRoutes(app: App) {
  const r = typed(app);
  const range = z.object({ from: z.iso.date(), to: z.iso.date() });

  r.get('/events', { preValidation: guard('events.view', F), schema: { tags: ['Events'], querystring: range } }, async (req) => ok(await listEvents(ctxOf(req), req.query.from, req.query.to)));
  r.get('/calendar', { preValidation: guard(), schema: { tags: ['Events'], summary: 'Events, exam dates and meetings in one feed', querystring: range } }, async (req) => {
    if (req.query.to < req.query.from) throw badRequest('Invalid range');
    return ok(await calendar(ctxOf(req), req.query.from, req.query.to));
  });
  r.post('/events', { preValidation: guard('events.create', F), schema: { tags: ['Events'], body: eventInput } }, async (req) => {
    const ctx = ctxOf(req);
    const { announce, ...v } = req.body;
    const [row] = await ctx.db.insert(events).values({ ...v, schoolId: ctx.schoolId, createdBy: ctx.userId }).returning();
    if (announce) await announceEvent(ctx, row);
    return ok(row);
  });
  r.put('/events/:id', { preValidation: guard('events.edit', F), schema: { tags: ['Events'], params: idParam, body: eventInput } }, async (req) => {
    const ctx = ctxOf(req);
    const { announce, ...v } = req.body;
    const [row] = await ctx.db.update(events).set(v).where(and(eq(events.id, req.params.id), eq(events.schoolId, ctx.schoolId))).returning();
    must(row, 'Event');
    if (announce) await announceEvent(ctx, row);
    return ok(row);
  });
  r.delete('/events/:id', { preValidation: guard('events.delete', F), schema: { tags: ['Events'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    await ctx.db.delete(events).where(and(eq(events.id, req.params.id), eq(events.schoolId, ctx.schoolId)));
    return ok({ deleted: true });
  });
}
