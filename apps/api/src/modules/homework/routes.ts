import { ctxOf, guard, idParam, ok, typed, type App } from '../../core/http';
import {
  assignmentDetail,
  assignmentInput,
  createAssignment,
  deleteAssignment,
  grade,
  gradeInput,
  listAssignments,
  listQuery,
  submit,
  submitInput,
  updateAssignment,
} from './service';

const F = { feature: 'homework' as const };

export async function homeworkRoutes(app: App) {
  const r = typed(app);
  r.get('/homework', { preValidation: guard('homework.view', F), schema: { tags: ['Homework'], querystring: listQuery } }, async (req) => ok(await listAssignments(ctxOf(req), req.query)));
  r.post('/homework', { preValidation: guard('homework.create', F), schema: { tags: ['Homework'], body: assignmentInput } }, async (req) => ok(await createAssignment(ctxOf(req), req.body)));
  r.get('/homework/:id', { preValidation: guard('homework.view', F), schema: { tags: ['Homework'], params: idParam } }, async (req) => ok(await assignmentDetail(ctxOf(req), req.params.id)));
  r.put('/homework/:id', { preValidation: guard('homework.edit', F), schema: { tags: ['Homework'], params: idParam, body: assignmentInput } }, async (req) =>
    ok(await updateAssignment(ctxOf(req), req.params.id, req.body)),
  );
  r.delete('/homework/:id', { preValidation: guard('homework.delete', F), schema: { tags: ['Homework'], params: idParam } }, async (req) => {
    await deleteAssignment(ctxOf(req), req.params.id);
    return ok({ deleted: true });
  });
  r.post('/homework/:id/submit', { preValidation: guard('homework.view', F), schema: { tags: ['Homework'], params: idParam, body: submitInput } }, async (req) =>
    ok(await submit(ctxOf(req), req.params.id, req.body)),
  );
  r.post('/homework/:id/grade', { preValidation: guard('homework.edit', F), schema: { tags: ['Homework'], params: idParam, body: gradeInput } }, async (req) =>
    ok(await grade(ctxOf(req), req.params.id, req.body)),
  );
}
