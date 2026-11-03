/** Weekly timetables, teacher clash detection and substitutions. */
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DAYS } from '@edumin/shared';
import { classes, periods, sections, substitutions, subjects, timetableEntries, users } from '../../db/schema';
import { assertSectionAccess, requirePermission, type Ctx } from '../../core/context';
import { badRequest, conflict, forbidden, must } from '../../core/errors';
import { getSection } from '../academics/routes';
import { createDoc, footer, letterhead, loadSchoolHeader, table, toBuffer } from '../../core/pdf';
import { notifyUsers } from '../../core/notify';

export const periodInput = z.object({
  name: z.string().trim().min(1).max(50),
  startTime: z.string().regex(/^\d{2}:\d{2}/),
  endTime: z.string().regex(/^\d{2}:\d{2}/),
  sortOrder: z.coerce.number().int().min(0),
  isBreak: z.boolean().default(false),
});

export async function listPeriods(ctx: Ctx) {
  return ctx.db.select().from(periods).where(eq(periods.schoolId, ctx.schoolId)).orderBy(asc(periods.sortOrder), asc(periods.startTime));
}

const entrySelect = {
  id: timetableEntries.id,
  sectionId: timetableEntries.sectionId,
  dayOfWeek: timetableEntries.dayOfWeek,
  periodId: timetableEntries.periodId,
  subjectId: timetableEntries.subjectId,
  subjectName: subjects.name,
  teacherId: timetableEntries.teacherId,
  teacherName: users.fullName,
  room: timetableEntries.room,
  sectionLabel: sql<string>`${classes.name} || ' - ' || ${sections.name}`,
};

function entriesQuery(ctx: Ctx) {
  return ctx.db
    .select(entrySelect)
    .from(timetableEntries)
    .innerJoin(sections, eq(sections.id, timetableEntries.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(subjects, eq(subjects.id, timetableEntries.subjectId))
    .leftJoin(users, eq(users.id, timetableEntries.teacherId));
}

export async function sectionTimetable(ctx: Ctx, sectionId: string) {
  requirePermission(ctx, 'timetable.view');
  await assertSectionAccess(ctx, sectionId);
  const section = await getSection(ctx, sectionId);
  const entries = await entriesQuery(ctx).where(eq(timetableEntries.sectionId, sectionId));
  return { section, periods: await listPeriods(ctx), entries };
}

export async function teacherTimetable(ctx: Ctx, teacherId: string) {
  requirePermission(ctx, 'timetable.view');
  if (ctx.scope !== 'school' && teacherId !== ctx.userId) throw forbidden();
  const [t] = await ctx.db.select({ id: users.id, fullName: users.fullName }).from(users).where(and(eq(users.id, teacherId), eq(users.schoolId, ctx.schoolId)));
  must(t, 'Teacher');
  const yearSections = await currentYearSectionIds(ctx);
  const entries = yearSections.length
    ? await entriesQuery(ctx).where(and(eq(timetableEntries.teacherId, teacherId), inArray(timetableEntries.sectionId, yearSections)))
    : [];
  return { teacher: t, periods: await listPeriods(ctx), entries };
}

async function currentYearSectionIds(ctx: Ctx, sectionId?: string) {
  // Clashes only matter within one academic year.
  const yearId = sectionId ? (await getSection(ctx, sectionId)).academicYearId : (await ctx.db.execute<{ id: string }>(sql`select id from academic_years where school_id = ${ctx.schoolId} and is_current limit 1`))[0]?.id;
  if (!yearId) return [];
  return (await ctx.db.select({ id: sections.id }).from(sections).where(and(eq(sections.schoolId, ctx.schoolId), eq(sections.academicYearId, yearId)))).map((r) => r.id);
}

export const gridInput = z.object({
  entries: z.array(
    z.object({
      dayOfWeek: z.coerce.number().int().min(1).max(7),
      periodId: z.uuid(),
      subjectId: z.uuid().nullish(),
      teacherId: z.uuid().nullish(),
      room: z.string().trim().max(50).nullish(),
    }),
  ),
});

/** Teacher clashes for a proposed grid (same teacher, same slot, another section). */
export async function findConflicts(ctx: Ctx, sectionId: string, entries: z.infer<typeof gridInput>['entries']) {
  const yearSections = (await currentYearSectionIds(ctx, sectionId)).filter((s) => s !== sectionId);
  const withTeacher = entries.filter((e) => e.teacherId);
  if (!withTeacher.length || !yearSections.length) return [];
  const others = await entriesQuery(ctx).where(
    and(inArray(timetableEntries.sectionId, yearSections), inArray(timetableEntries.teacherId, [...new Set(withTeacher.map((e) => e.teacherId!))])),
  );
  const out = [];
  for (const e of withTeacher) {
    const clash = others.find((o) => o.teacherId === e.teacherId && o.dayOfWeek === e.dayOfWeek && o.periodId === e.periodId);
    if (clash) out.push({ dayOfWeek: e.dayOfWeek, periodId: e.periodId, teacherId: e.teacherId, teacherName: clash.teacherName, otherSection: clash.sectionLabel });
  }
  return out;
}

export async function saveSectionTimetable(ctx: Ctx, sectionId: string, v: z.infer<typeof gridInput>) {
  requirePermission(ctx, 'timetable.edit');
  await getSection(ctx, sectionId);
  const slots = new Set<string>();
  for (const e of v.entries) {
    const k = `${e.dayOfWeek}|${e.periodId}`;
    if (slots.has(k)) throw badRequest('A slot appears twice');
    slots.add(k);
  }
  const ps = await listPeriods(ctx);
  const periodIds = new Set(ps.map((p) => p.id));
  if (v.entries.some((e) => !periodIds.has(e.periodId))) throw badRequest('Unknown period');
  const clashes = await findConflicts(ctx, sectionId, v.entries);
  if (clashes.length) throw conflict('Some teachers are already booked in another class at the same time', clashes);
  await ctx.db.transaction(async (tx) => {
    await tx.delete(timetableEntries).where(eq(timetableEntries.sectionId, sectionId));
    const rows = v.entries.filter((e) => e.subjectId || e.teacherId);
    if (rows.length) await tx.insert(timetableEntries).values(rows.map((e) => ({ ...e, schoolId: ctx.schoolId, sectionId })));
  });
  return sectionTimetable(ctx, sectionId);
}

/** Today's schedule (with substitutions applied) for a teacher. */
export async function teacherDay(ctx: Ctx, teacherId: string, date: string) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay() || 7;
  const yearSections = await currentYearSectionIds(ctx);
  if (!yearSections.length) return [];
  const own = await entriesQuery(ctx).where(and(eq(timetableEntries.teacherId, teacherId), eq(timetableEntries.dayOfWeek, dow), inArray(timetableEntries.sectionId, yearSections)));
  const subs = await ctx.db.select().from(substitutions).where(and(eq(substitutions.schoolId, ctx.schoolId), eq(substitutions.date, date)));
  const covering = subs.filter((s) => s.substituteTeacherId === teacherId);
  const coveredEntries = covering.length ? await entriesQuery(ctx).where(inArray(timetableEntries.id, covering.map((c) => c.entryId))) : [];
  const ps = await listPeriods(ctx);
  const pmap = new Map(ps.map((p) => [p.id, p]));
  return [
    ...own.map((e) => ({ ...e, substitutedBy: subs.find((s) => s.entryId === e.id)?.substituteTeacherId ?? null, isSubstitution: false })),
    ...coveredEntries.map((e) => ({ ...e, substitutedBy: null, isSubstitution: true })),
  ]
    .map((e) => ({ ...e, period: pmap.get(e.periodId)! }))
    .sort((a, b) => a.period.sortOrder - b.period.sortOrder);
}

export async function listSubstitutions(ctx: Ctx, date: string) {
  requirePermission(ctx, 'timetable.view');
  const rows = await ctx.db
    .select({ sub: substitutions, entry: entrySelect, substituteName: sql<string>`(select full_name from users where id = ${substitutions.substituteTeacherId})` })
    .from(substitutions)
    .innerJoin(timetableEntries, eq(timetableEntries.id, substitutions.entryId))
    .innerJoin(sections, eq(sections.id, timetableEntries.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(subjects, eq(subjects.id, timetableEntries.subjectId))
    .leftJoin(users, eq(users.id, timetableEntries.teacherId))
    .where(and(eq(substitutions.schoolId, ctx.schoolId), eq(substitutions.date, date)));
  return rows.map((r) => ({ ...r.sub, ...r.entry, id: r.sub.id, entryId: r.entry.id, substituteName: r.substituteName }));
}

/** Teachers free in a given slot on a date (for picking a substitute). */
export async function freeTeachers(ctx: Ctx, entryId: string, date: string) {
  requirePermission(ctx, 'timetable.view');
  const [e] = await ctx.db.select().from(timetableEntries).where(and(eq(timetableEntries.id, entryId), eq(timetableEntries.schoolId, ctx.schoolId)));
  must(e, 'Timetable entry');
  const yearSections = await currentYearSectionIds(ctx, e.sectionId);
  const busy = await ctx.db
    .select({ id: timetableEntries.teacherId })
    .from(timetableEntries)
    .where(and(inArray(timetableEntries.sectionId, yearSections), eq(timetableEntries.dayOfWeek, e.dayOfWeek), eq(timetableEntries.periodId, e.periodId)));
  const subBusy = await ctx.db
    .select({ id: substitutions.substituteTeacherId })
    .from(substitutions)
    .innerJoin(timetableEntries, eq(timetableEntries.id, substitutions.entryId))
    .where(and(eq(substitutions.date, date), eq(timetableEntries.periodId, e.periodId), eq(substitutions.schoolId, ctx.schoolId)));
  const busySet = new Set([...busy, ...subBusy].map((b) => b.id));
  const teachers = await ctx.db.execute<{ id: string; full_name: string }>(
    sql`select u.id, u.full_name from users u join roles r on r.id = u.role_id where u.school_id = ${ctx.schoolId} and u.is_active and r.key in ('teacher','principal') order by u.full_name`,
  );
  return (teachers as unknown as { id: string; full_name: string }[]).filter((t) => !busySet.has(t.id)).map((t) => ({ id: t.id, fullName: t.full_name }));
}

export const substitutionInput = z.object({ entryId: z.uuid(), date: z.iso.date(), substituteTeacherId: z.uuid(), reason: z.string().trim().max(500).nullish() });

export async function createSubstitution(ctx: Ctx, v: z.infer<typeof substitutionInput>) {
  requirePermission(ctx, 'timetable.edit');
  const [e] = await ctx.db.select().from(timetableEntries).where(and(eq(timetableEntries.id, v.entryId), eq(timetableEntries.schoolId, ctx.schoolId)));
  must(e, 'Timetable entry');
  const dow = new Date(v.date + 'T00:00:00Z').getUTCDay() || 7;
  if (dow !== e.dayOfWeek) throw badRequest('The date does not fall on this timetable day');
  if (v.substituteTeacherId === e.teacherId) throw badRequest('Choose a different teacher');
  const free = await freeTeachers(ctx, v.entryId, v.date);
  if (!free.some((t) => t.id === v.substituteTeacherId)) throw conflict('The selected teacher is not free in this period');
  const [row] = await ctx.db
    .insert(substitutions)
    .values({ ...v, schoolId: ctx.schoolId, createdBy: ctx.userId })
    .onConflictDoUpdate({ target: [substitutions.entryId, substitutions.date], set: { substituteTeacherId: v.substituteTeacherId, reason: v.reason ?? null } })
    .returning();
  await notifyUsers(ctx.db, ctx.schoolId, [v.substituteTeacherId], { type: 'substitution', title: 'Substitution assigned', body: `You are covering a class on ${v.date}`, link: '/timetable' });
  return row;
}

export async function deleteSubstitution(ctx: Ctx, id: string) {
  requirePermission(ctx, 'timetable.edit');
  await ctx.db.delete(substitutions).where(and(eq(substitutions.id, id), eq(substitutions.schoolId, ctx.schoolId)));
}

export async function timetablePdf(ctx: Ctx, kind: 'section' | 'teacher', id: string) {
  const data = kind === 'section' ? await sectionTimetable(ctx, id) : await teacherTimetable(ctx, id);
  const title = kind === 'section' ? `Timetable · ${await sectionLabel(ctx, id)}` : `Timetable · ${(data as Awaited<ReturnType<typeof teacherTimetable>>).teacher.fullName}`;
  const h = await loadSchoolHeader(ctx.schoolId);
  const doc = createDoc({ landscape: true });
  const y = letterhead(doc, h, title);
  const days = DAYS;
  const ps = data.periods;
  const cell = (day: number, periodId: string) => {
    const e = data.entries.find((x) => x.dayOfWeek === day && x.periodId === periodId);
    if (!e) return '';
    return kind === 'section' ? `${e.subjectName ?? ''}${e.teacherName ? ' · ' + e.teacherName.split(' ')[0] : ''}` : `${e.sectionLabel} · ${e.subjectName ?? ''}`;
  };
  table(
    doc,
    y,
    [{ label: 'Period', width: 0.16 }, ...days.map((d) => ({ label: d.label, width: 0.84 / days.length }))],
    ps.map((p) => [`${p.name} (${p.startTime.slice(0, 5)}–${p.endTime.slice(0, 5)})`, ...days.map((d) => (p.isBreak ? '— Break —' : cell(d.value, p.id)))]),
    h.branding.primaryColor,
  );
  footer(doc, h);
  return { buffer: await toBuffer(doc), filename: `timetable-${kind}.pdf` };
}

async function sectionLabel(ctx: Ctx, sectionId: string) {
  const [s] = await ctx.db
    .select({ label: sql<string>`${classes.name} || ' - ' || ${sections.name}` })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .where(eq(sections.id, sectionId));
  return s?.label ?? '';
}

