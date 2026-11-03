import { ctxOf, guard, ok, typed, type App } from '../../core/http';
import { dashboardFor } from './service';

export async function dashboardRoutes(app: App) {
  typed(app).get('/dashboard', { preValidation: guard(), schema: { tags: ['Dashboard'], summary: "Dashboard for the caller's role" } }, async (req) => ok(await dashboardFor(ctxOf(req))));
}
