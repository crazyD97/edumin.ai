import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { periods } from '../../db/schema';
import { must } from '../../core/errors';
import { ctxOf, guard, idParam, ok, sendFile, typed, type App } from '../../core/http';
import {
  createSubstitution,
  deleteSubstitution,
  findConflicts,
  freeTeachers,
  gridInput,
  listPeriods,
  listSubstitutions,
  periodInput,
  saveSectionTimetable,
  sectionTimetable,
  substitutionInput,
  teacherDay,
  teacherTimetable,
  timetablePdf,
} from './service';

const F = { feature: 'timetable' as const };

export async function timetableRoutes(app: App) {
  const r = typed(app);

  r.get('/periods', { preValidation: guard('timetable.view', F), schema: { tags: ['Timetable'] } }, async (req) => ok(await listPeriods(ctxOf(req))));
  r.post('/periods', { preValidation: guard('timetable.create', F), schema: { tags: ['Timetable'], body: periodInput } }, async (req) => {
    const ctx = ctxOf(req);
    const [row] = await ctx.db.insert(periods).values({ ...req.body, schoolId: ctx.schoolId }).returning();
    return ok(row);
  });
  r.put('/periods/:id', { preValidation: guard('timetable.edit', F), schema: { tags: ['Timetable'], params: idParam, body: periodInput } }, async (req) => {
    const ctx = ctxOf(req);
    const [row] = await ctx.db.update(periods).set(req.body).where(and(eq(periods.id, req.params.id), eq(periods.schoolId, ctx.schoolId))).returning();
    return ok(must(row, 'Period'));
  });
  r.delete('/periods/:id', { preValidation: guard('timetable.delete', F), schema: { tags: ['Timetable'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    await ctx.db.delete(periods).where(and(eq(periods.id, req.params.id), eq(periods.schoolId, ctx.schoolId)));
    return ok({ deleted: true });
  });

  r.get('/timetable/sections/:id', { preValidation: guard('timetable.view', F), schema: { tags: ['Timetable'], params: idParam } }, async (req) => ok(await sectionTimetable(ctxOf(req), req.params.id)));
  r.put('/timetable/sections/:id', { preValidation: guard('timetable.edit', F), schema: { tags: ['Timetable'], summary: 'Replace a section timetable; 409 on teacher clashes', params: idParam, body: gridInput } }, async (req) =>
    ok(await saveSectionTimetable(ctxOf(req), req.params.id, req.body)),
  );
  r.post('/timetable/sections/:id/check', { preValidation: guard('timetable.view', F), schema: { tags: ['Timetable'], params: idParam, body: gridInput } }, async (req) =>
    ok(await findConflicts(ctxOf(req), req.params.id, req.body.entries)),
  );
  r.get('/timetable/sections/:id/pdf', { preValidation: guard('timetable.view', F), schema: { tags: ['Timetable'], params: idParam } }, async (req, reply) => {
    const { buffer, filename } = await timetablePdf(ctxOf(req), 'section', req.params.id);
    return sendFile(reply, buffer, filename, 'application/pdf');
  });

  r.get('/timetable/teachers/:id', { preValidation: guard('timetable.view', F), schema: { tags: ['Timetable'], params: idParam } }, async (req) => ok(await teacherTimetable(ctxOf(req), req.params.id)));
  r.get('/timetable/teachers/:id/pdf', { preValidation: guard('timetable.view', F), schema: { tags: ['Timetable'], params: idParam } }, async (req, reply) => {
    const { buffer, filename } = await timetablePdf(ctxOf(req), 'teacher', req.params.id);
    return sendFile(reply, buffer, filename, 'application/pdf');
  });
  r.get('/timetable/my-day', { preValidation: guard('timetable.view', F), schema: { tags: ['Timetable'], querystring: z.object({ date: z.iso.date().optional() }) } }, async (req) => {
    const ctx = ctxOf(req);
    return ok(await teacherDay(ctx, ctx.userId, req.query.date ?? new Date().toISOString().slice(0, 10)));
  });

  r.get('/substitutions', { preValidation: guard('timetable.view', F), schema: { tags: ['Timetable'], querystring: z.object({ date: z.iso.date() }) } }, async (req) => ok(await listSubstitutions(ctxOf(req), req.query.date)));
  r.get('/substitutions/free-teachers', { preValidation: guard('timetable.view', F), schema: { tags: ['Timetable'], querystring: z.object({ entryId: z.uuid(), date: z.iso.date() }) } }, async (req) =>
    ok(await freeTeachers(ctxOf(req), req.query.entryId, req.query.date)),
  );
  r.post('/substitutions', { preValidation: guard('timetable.edit', F), schema: { tags: ['Timetable'], body: substitutionInput } }, async (req) => ok(await createSubstitution(ctxOf(req), req.body)));
  r.delete('/substitutions/:id', { preValidation: guard('timetable.edit', F), schema: { tags: ['Timetable'], params: idParam } }, async (req) => {
    await deleteSubstitution(ctxOf(req), req.params.id);
    return ok({ deleted: true });
  });
}
