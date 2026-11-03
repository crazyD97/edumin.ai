import { z } from 'zod';
import { and, count, eq } from 'drizzle-orm';
import { exams, gradingScales } from '../../db/schema';
import { conflict, must } from '../../core/errors';
import { ctxOf, guard, idParam, ok, sendFile, typed, type App } from '../../core/http';
import {
  createExam,
  examInput,
  examResults,
  getExam,
  getMarksSheet,
  gradingInput,
  listExams,
  listPapers,
  marksInput,
  papersInput,
  publishExam,
  reportCardPdf,
  saveMarks,
  savePapers,
  studentHistory,
  updateExam,
} from './service';

const F = { feature: 'exams' as const };

export async function examRoutes(app: App) {
  const r = typed(app);

  // Grading scales
  r.get('/grading-scales', { preValidation: guard('exams.view', F), schema: { tags: ['Exams'] } }, async (req) => {
    const ctx = ctxOf(req);
    return ok(await ctx.db.select().from(gradingScales).where(eq(gradingScales.schoolId, ctx.schoolId)));
  });
  const saveScale = async (ctx: ReturnType<typeof ctxOf>, body: z.infer<typeof gradingInput>, id?: string) =>
    ctx.db.transaction(async (tx) => {
      if (body.isDefault) await tx.update(gradingScales).set({ isDefault: false }).where(eq(gradingScales.schoolId, ctx.schoolId));
      const [row] = id
        ? await tx.update(gradingScales).set(body).where(and(eq(gradingScales.id, id), eq(gradingScales.schoolId, ctx.schoolId))).returning()
        : await tx.insert(gradingScales).values({ ...body, schoolId: ctx.schoolId }).returning();
      return must(row, 'Grading scale');
    });
  r.post('/grading-scales', { preValidation: guard('exams.approve', F), schema: { tags: ['Exams'], body: gradingInput } }, async (req) => ok(await saveScale(ctxOf(req), req.body)));
  r.put('/grading-scales/:id', { preValidation: guard('exams.approve', F), schema: { tags: ['Exams'], params: idParam, body: gradingInput } }, async (req) =>
    ok(await saveScale(ctxOf(req), req.body, req.params.id)),
  );
  r.delete('/grading-scales/:id', { preValidation: guard('exams.approve', F), schema: { tags: ['Exams'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    const [{ n }] = await ctx.db.select({ n: count() }).from(exams).where(eq(exams.gradingScaleId, req.params.id));
    if (n) throw conflict('This grading scale is used by examinations');
    await ctx.db.delete(gradingScales).where(and(eq(gradingScales.id, req.params.id), eq(gradingScales.schoolId, ctx.schoolId)));
    return ok({ deleted: true });
  });

  // Exams
  r.get('/exams', { preValidation: guard('exams.view', F), schema: { tags: ['Exams'], querystring: z.object({ academicYearId: z.uuid().optional() }) } }, async (req) =>
    ok(await listExams(ctxOf(req), req.query.academicYearId)),
  );
  r.post('/exams', { preValidation: guard('exams.create', F), schema: { tags: ['Exams'], body: examInput } }, async (req) => ok(await createExam(ctxOf(req), req.body)));
  r.get('/exams/:id', { preValidation: guard('exams.view', F), schema: { tags: ['Exams'], params: idParam } }, async (req) => ok(await getExam(ctxOf(req), req.params.id)));
  r.put('/exams/:id', { preValidation: guard('exams.edit', F), schema: { tags: ['Exams'], params: idParam, body: examInput } }, async (req) => ok(await updateExam(ctxOf(req), req.params.id, req.body)));
  r.delete('/exams/:id', { preValidation: guard('exams.delete', F), schema: { tags: ['Exams'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    const exam = await getExam(ctx, req.params.id);
    if (exam.status === 'published') throw conflict('Published examinations are part of the academic record and cannot be deleted');
    await ctx.db.delete(exams).where(eq(exams.id, exam.id));
    return ok({ deleted: true });
  });

  r.get('/exams/:id/papers', { preValidation: guard('exams.view', F), schema: { tags: ['Exams'], params: idParam, querystring: z.object({ classId: z.uuid().optional() }) } }, async (req) =>
    ok(await listPapers(ctxOf(req), req.params.id, req.query.classId)),
  );
  r.put('/exams/:id/papers', { preValidation: guard('exams.edit', F), schema: { tags: ['Exams'], summary: 'Set the exam schedule for one class', params: idParam, body: papersInput } }, async (req) =>
    ok(await savePapers(ctxOf(req), req.params.id, req.body)),
  );

  r.get('/exam-papers/:id/marks', { preValidation: guard('exams.view', F), schema: { tags: ['Exams'], params: idParam, querystring: z.object({ sectionId: z.uuid() }) } }, async (req) =>
    ok(await getMarksSheet(ctxOf(req), req.params.id, req.query.sectionId)),
  );
  r.put('/exam-papers/:id/marks', { preValidation: guard('exams.edit', F), schema: { tags: ['Exams'], params: idParam, body: marksInput } }, async (req) =>
    ok(await saveMarks(ctxOf(req), req.params.id, req.body)),
  );

  r.get(
    '/exams/:id/results',
    { preValidation: guard('exams.view', F), schema: { tags: ['Exams'], params: idParam, querystring: z.object({ classId: z.uuid().optional(), sectionId: z.uuid().optional() }) } },
    async (req) => ok(await examResults(ctxOf(req), req.params.id, req.query)),
  );
  r.post('/exams/:id/publish', { preValidation: guard('exams.approve', F), schema: { tags: ['Exams'], summary: 'Approve & publish results (or unpublish)', params: idParam, body: z.object({ publish: z.boolean() }) } }, async (req) =>
    ok(await publishExam(ctxOf(req), req.params.id, req.body.publish)),
  );
  r.get(
    '/exams/:id/report-cards',
    { preValidation: guard('exams.view', F), schema: { tags: ['Exams'], summary: 'PDF report card(s) for a student or a whole section', params: idParam, querystring: z.object({ studentId: z.uuid().optional(), sectionId: z.uuid().optional() }) } },
    async (req, reply) => {
      const { buffer, filename } = await reportCardPdf(ctxOf(req), req.params.id, req.query);
      return sendFile(reply, buffer, filename, 'application/pdf');
    },
  );
  r.get('/students/:id/exam-history', { preValidation: guard('exams.view', F), schema: { tags: ['Exams'], params: idParam } }, async (req) => ok(await studentHistory(ctxOf(req), req.params.id)));
}
