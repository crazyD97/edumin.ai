/** Parent–teacher meetings: availability slots, booking, approval, notes, reminders. */
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { MEETING_STATUSES } from '@edumin/shared';
import { enrollments, guardians, meetingSlots, meetings, sectionSubjects, sections, studentGuardians, students, subjects, users } from '../../db/schema';
import { db } from '../../core/db';
import { badRequest, conflict, forbidden, must } from '../../core/errors';
import { ctxOf, guard, idParam, ok, typed, type App } from '../../core/http';
import { assertStudentAccess, currentYearId, ownStudentIds, requirePermission, type Ctx } from '../../core/context';
import { notifyUsers } from '../../core/notify';
import { registerJob } from '../../jobs';

const F = { feature: 'meetings' as const };
const fmt = (d: Date) => d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/** Teachers a parent may meet about a child: class teacher and subject teachers. */
export async function teachersForStudent(ctx: Ctx, studentId: string) {
  await assertStudentAccess(ctx, studentId);
  const yearId = await currentYearId(ctx);
  const [e] = await ctx.db
    .select({ sectionId: enrollments.sectionId, classTeacherId: sections.classTeacherId })
    .from(enrollments)
    .innerJoin(sections, eq(sections.id, enrollments.sectionId))
    .where(and(eq(enrollments.studentId, studentId), yearId ? eq(enrollments.academicYearId, yearId) : undefined));
  if (!e) return [];
  const subs = await ctx.db
    .select({ id: users.id, fullName: users.fullName, subject: subjects.name })
    .from(sectionSubjects)
    .innerJoin(users, eq(users.id, sectionSubjects.teacherId))
    .innerJoin(subjects, eq(subjects.id, sectionSubjects.subjectId))
    .where(eq(sectionSubjects.sectionId, e.sectionId));
  const map = new Map<string, { id: string; fullName: string; roles: string[] }>();
  if (e.classTeacherId) {
    const [ct] = await ctx.db.select({ id: users.id, fullName: users.fullName }).from(users).where(eq(users.id, e.classTeacherId));
    if (ct) map.set(ct.id, { ...ct, roles: ['Class Teacher'] });
  }
  for (const s of subs) {
    const cur = map.get(s.id) ?? { id: s.id, fullName: s.fullName, roles: [] };
    cur.roles.push(s.subject);
    map.set(s.id, cur);
  }
  return [...map.values()];
}

async function parentUsersForStudent(studentId: string) {
  const rows = await db
    .select({ id: guardians.userId })
    .from(studentGuardians)
    .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .where(eq(studentGuardians.studentId, studentId));
  return rows.map((r) => r.id).filter(Boolean) as string[];
}

const meetingSelect = {
  m: meetings,
  teacherName: users.fullName,
  studentName: sql<string | null>`${students.firstName} || ' ' || ${students.lastName}`,
  parentName: sql<string | null>`(select full_name from users p where p.id = ${meetings.parentUserId})`,
  classLabel: sql<string | null>`(select c.name || ' - ' || s.name from enrollments e join sections s on s.id = e.section_id join classes c on c.id = s.class_id
    join academic_years y on y.id = e.academic_year_id and y.is_current where e.student_id = ${meetings.studentId} limit 1)`,
};

export async function meetingRoutes(app: App) {
  const r = typed(app);

  r.get('/meetings/teachers', { preValidation: guard('meetings.view', F), schema: { tags: ['Meetings'], querystring: z.object({ studentId: z.uuid() }) } }, async (req) =>
    ok(await teachersForStudent(ctxOf(req), req.query.studentId)),
  );

  // ── Slots ──
  r.get(
    '/meetings/slots',
    { preValidation: guard('meetings.view', F), schema: { tags: ['Meetings'], querystring: z.object({ teacherId: z.uuid().optional(), from: z.iso.date(), to: z.iso.date(), onlyFree: z.enum(['true', 'false']).optional() }) } },
    async (req) => {
      const ctx = ctxOf(req);
      const teacherId = req.query.teacherId ?? ctx.userId;
      const rows = await ctx.db
        .select()
        .from(meetingSlots)
        .where(
          and(
            eq(meetingSlots.schoolId, ctx.schoolId),
            eq(meetingSlots.teacherId, teacherId),
            gte(meetingSlots.startsAt, new Date(req.query.from + 'T00:00:00')),
            lte(meetingSlots.startsAt, new Date(req.query.to + 'T23:59:59')),
            req.query.onlyFree === 'true' ? and(eq(meetingSlots.isBooked, false), gte(meetingSlots.startsAt, new Date())) : undefined,
          ),
        )
        .orderBy(asc(meetingSlots.startsAt));
      return ok(rows);
    },
  );

  r.post(
    '/meetings/slots',
    {
      preValidation: guard('meetings.create', F),
      schema: {
        tags: ['Meetings'],
        summary: 'Publish availability: splits a time window into bookable slots',
        body: z.object({ date: z.iso.date(), from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/), durationMin: z.coerce.number().int().min(5).max(120), location: z.string().trim().max(100).nullish() }),
      },
    },
    async (req) => {
      const ctx = ctxOf(req);
      if (ctx.scope === 'own') throw forbidden();
      const { date, from, to, durationMin, location } = req.body;
      const start = new Date(`${date}T${from}:00`);
      const end = new Date(`${date}T${to}:00`);
      if (end <= start) throw badRequest('End time must be after start time');
      if (start < new Date()) throw badRequest('Slots must be in the future');
      const slots = [];
      for (let t = start.getTime(); t + durationMin * 60000 <= end.getTime(); t += durationMin * 60000) {
        slots.push({ schoolId: ctx.schoolId, teacherId: ctx.userId, startsAt: new Date(t), endsAt: new Date(t + durationMin * 60000), location: location ?? null });
      }
      if (!slots.length) throw badRequest('The window is shorter than one slot');
      const overlap = await ctx.db
        .select({ id: meetingSlots.id })
        .from(meetingSlots)
        .where(and(eq(meetingSlots.teacherId, ctx.userId), sql`${meetingSlots.startsAt} < ${end} and ${meetingSlots.endsAt} > ${start}`))
        .limit(1);
      if (overlap.length) throw conflict('You already have slots in this window');
      const rows = await ctx.db.insert(meetingSlots).values(slots).returning();
      return ok(rows);
    },
  );

  r.delete('/meetings/slots/:id', { preValidation: guard('meetings.create', F), schema: { tags: ['Meetings'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    const [s] = await ctx.db.select().from(meetingSlots).where(and(eq(meetingSlots.id, req.params.id), eq(meetingSlots.schoolId, ctx.schoolId)));
    must(s, 'Slot');
    if (s.teacherId !== ctx.userId && ctx.scope !== 'school') throw forbidden();
    if (s.isBooked) throw conflict('This slot is booked; cancel the meeting instead');
    await ctx.db.delete(meetingSlots).where(eq(meetingSlots.id, s.id));
    return ok({ deleted: true });
  });

  // ── Meetings ──
  r.get(
    '/meetings',
    {
      preValidation: guard('meetings.view', F),
      schema: { tags: ['Meetings'], querystring: z.object({ status: z.enum(MEETING_STATUSES).optional(), scope: z.enum(['upcoming', 'past', 'all']).default('all'), studentId: z.uuid().optional() }) },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const now = new Date();
      let who;
      if (ctx.scope === 'school') who = undefined;
      else if (ctx.scope === 'assigned') who = eq(meetings.teacherId, ctx.userId);
      else {
        const own = await ownStudentIds(ctx);
        who = or(eq(meetings.parentUserId, ctx.userId), own.length ? inArray(meetings.studentId, own) : sql`false`);
      }
      const rows = await ctx.db
        .select(meetingSelect)
        .from(meetings)
        .innerJoin(users, eq(users.id, meetings.teacherId))
        .leftJoin(students, eq(students.id, meetings.studentId))
        .where(
          and(
            eq(meetings.schoolId, ctx.schoolId),
            who,
            req.query.status ? eq(meetings.status, req.query.status) : undefined,
            req.query.studentId ? eq(meetings.studentId, req.query.studentId) : undefined,
            req.query.scope === 'upcoming' ? gte(meetings.endsAt, now) : req.query.scope === 'past' ? lte(meetings.endsAt, now) : undefined,
          ),
        )
        .orderBy(req.query.scope === 'upcoming' ? asc(meetings.startsAt) : desc(meetings.startsAt))
        .limit(300);
      return ok(rows.map((r) => ({ ...r.m, teacherName: r.teacherName, studentName: r.studentName, parentName: r.parentName, classLabel: r.classLabel })));
    },
  );

  r.post(
    '/meetings',
    {
      preValidation: guard('meetings.create', F),
      schema: {
        tags: ['Meetings'],
        summary: 'Parents book a teacher slot (needs approval); staff schedule directly',
        body: z.object({
          studentId: z.uuid(),
          slotId: z.uuid().optional(),
          teacherId: z.uuid().optional(),
          startsAt: z.iso.datetime({ offset: true, local: true }).optional(),
          durationMin: z.coerce.number().int().min(5).max(180).default(15),
          location: z.string().trim().max(100).nullish(),
          agenda: z.string().trim().max(2000).nullish(),
        }),
      },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const b = req.body;
      await assertStudentAccess(ctx, b.studentId);
      const isParent = ctx.scope === 'own';
      let row;
      if (isParent) {
        if (!b.slotId) throw badRequest('Choose an available slot');
        row = await ctx.db.transaction(async (tx) => {
          const [slot] = await tx
            .update(meetingSlots)
            .set({ isBooked: true })
            .where(and(eq(meetingSlots.id, b.slotId!), eq(meetingSlots.schoolId, ctx.schoolId), eq(meetingSlots.isBooked, false), gte(meetingSlots.startsAt, new Date())))
            .returning();
          if (!slot) throw conflict('This slot is no longer available');
          const allowed = await teachersForStudent(ctx, b.studentId);
          if (!allowed.some((t) => t.id === slot.teacherId)) throw forbidden("This teacher doesn't teach your child");
          const [m] = await tx
            .insert(meetings)
            .values({ schoolId: ctx.schoolId, teacherId: slot.teacherId, parentUserId: ctx.userId, studentId: b.studentId, slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, location: slot.location, agenda: b.agenda, status: 'requested', requestedBy: ctx.userId })
            .returning();
          return m;
        });
        await notifyUsers(ctx.db, ctx.schoolId, [row.teacherId], { type: 'meeting_request', title: 'New meeting request', body: `${fmt(row.startsAt)}${b.agenda ? ' — ' + b.agenda : ''}`, link: '/meetings' });
      } else {
        if (!b.startsAt) throw badRequest('Choose a date and time');
        const teacherId = b.teacherId ?? ctx.userId;
        const startsAt = new Date(b.startsAt);
        const parents = await parentUsersForStudent(b.studentId);
        [row] = await ctx.db
          .insert(meetings)
          .values({ schoolId: ctx.schoolId, teacherId, parentUserId: parents[0] ?? null, studentId: b.studentId, startsAt, endsAt: new Date(startsAt.getTime() + b.durationMin * 60000), location: b.location, agenda: b.agenda, status: 'approved', requestedBy: ctx.userId })
          .returning();
        await notifyUsers(ctx.db, ctx.schoolId, parents, { type: 'meeting_scheduled', title: 'Parent–teacher meeting scheduled', body: `${fmt(startsAt)}${b.location ? ' at ' + b.location : ''}`, link: '/meetings', deliver: { event: 'meeting', vars: { detail: `Parent–teacher meeting scheduled on ${fmt(startsAt)}${b.location ? ' at ' + b.location : ''}.` } }, createdBy: ctx.userId });
      }
      return ok(row);
    },
  );

  r.patch(
    '/meetings/:id',
    {
      preValidation: guard('meetings.view', F),
      schema: { tags: ['Meetings'], summary: 'Approve, reject, cancel, complete or add notes', params: idParam, body: z.object({ status: z.enum(['approved', 'rejected', 'cancelled', 'completed']).optional(), notes: z.string().trim().max(5000).nullish() }) },
    },
    async (req) => {
      const ctx = ctxOf(req);
      const [m] = await ctx.db.select().from(meetings).where(and(eq(meetings.id, req.params.id), eq(meetings.schoolId, ctx.schoolId)));
      must(m, 'Meeting');
      const isTeacherSide = m.teacherId === ctx.userId || ctx.scope === 'school';
      const isParentSide = m.parentUserId === ctx.userId;
      if (!isTeacherSide && !isParentSide) throw forbidden();
      const s = req.body.status;
      if (s && ['approved', 'rejected', 'completed'].includes(s)) {
        if (!isTeacherSide) throw forbidden();
        requirePermission(ctx, 'meetings.approve');
      }
      if (req.body.notes !== undefined && !isTeacherSide) throw forbidden('Only staff can add meeting notes');
      if (s === 'approved' && m.status !== 'requested') throw badRequest('Only requested meetings can be approved');
      const [row] = await ctx.db.update(meetings).set(req.body).where(eq(meetings.id, m.id)).returning();
      if (s && ['rejected', 'cancelled'].includes(s) && m.slotId) await ctx.db.update(meetingSlots).set({ isBooked: false }).where(eq(meetingSlots.id, m.slotId));
      if (s && s !== m.status) {
        const target = isTeacherSide ? [m.parentUserId!].filter(Boolean) : [m.teacherId];
        await notifyUsers(ctx.db, ctx.schoolId, target, { type: 'meeting_update', title: `Meeting ${s}`, body: fmt(m.startsAt), link: '/meetings', deliver: { event: 'meeting', vars: { detail: `Your parent–teacher meeting on ${fmt(m.startsAt)} was ${s}.` } }, createdBy: ctx.userId });
      }
      return ok(row);
    },
  );
}

/** Reminder job: notify both sides ~24h before an approved meeting. */
registerJob({
  name: 'meeting-reminders',
  everyMs: 5 * 60_000,
  run: async () => {
    const due = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.status, 'approved'), sql`${meetings.reminderSentAt} is null`, sql`${meetings.startsAt} between now() and now() + interval '24 hours'`));
    for (const m of due) {
      await notifyUsers(db, m.schoolId, [m.teacherId, m.parentUserId!].filter(Boolean), { type: 'meeting_reminder', title: 'Meeting reminder', body: `Parent–teacher meeting on ${fmt(m.startsAt)}`, link: '/meetings', deliver: { event: 'meeting', vars: { detail: `Reminder: parent–teacher meeting on ${fmt(m.startsAt)}${m.location ? ' at ' + m.location : ''}.` } } });
      await db.update(meetings).set({ reminderSentAt: new Date() }).where(eq(meetings.id, m.id));
    }
  },
});

