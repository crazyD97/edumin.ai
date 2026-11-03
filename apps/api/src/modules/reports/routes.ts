import { z } from 'zod';
import { badRequest } from '../../core/errors';
import { ctxOf, guard, ok, sendFile, typed, type App } from '../../core/http';
import { requirePermission } from '../../core/context';
import { MIME, exportReport } from '../../core/export';
import { availableReports, runReport } from './registry';

const F = { feature: 'reports' as const };

export async function reportRoutes(app: App) {
  const r = typed(app);

  r.get('/reports', { preValidation: guard('reports.view', F), schema: { tags: ['Reports'], summary: 'Report catalogue with JSON-schema parameters' } }, async (req) => {
    const ctx = ctxOf(req);
    return ok(
      availableReports(ctx).map((d) => ({
        key: d.key,
        name: d.name,
        description: d.description,
        category: d.category,
        params: z.toJSONSchema(d.params, { io: 'input', unrepresentable: 'any' }),
      })),
    );
  });

  r.post('/reports/:key/run', { preValidation: guard('reports.view', F), schema: { tags: ['Reports'], params: z.object({ key: z.string() }), body: z.object({ params: z.record(z.string(), z.unknown()).default({}) }) } }, async (req) =>
    ok(await runReport(ctxOf(req), req.params.key, req.body.params)),
  );

  r.post(
    '/reports/:key/export',
    {
      preValidation: guard(['reports.view', 'reports.export'], F),
      schema: { tags: ['Reports'], params: z.object({ key: z.string() }), body: z.object({ format: z.enum(['pdf', 'xlsx', 'csv']), params: z.record(z.string(), z.unknown()).default({}) }) },
    },
    async (req, reply) => {
      const ctx = ctxOf(req);
      requirePermission(ctx, 'reports.export');
      const result = await runReport(ctx, req.params.key, req.body.params);
      if (result.rows.length > 20000) throw badRequest('Report too large to export; narrow the filters');
      const buf = await exportReport(result, req.body.format, ctx.schoolId);
      return sendFile(reply, buf, `${req.params.key}-${new Date().toISOString().slice(0, 10)}.${req.body.format}`, MIME[req.body.format]);
    },
  );
}
