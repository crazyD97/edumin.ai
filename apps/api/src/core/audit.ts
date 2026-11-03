import { auditLogs } from '../db/schema';
import type { Ctx } from './context';

/** Records who did what. Failures are swallowed — auditing must never break the action. */
export async function audit(ctx: Pick<Ctx, 'db' | 'userId'> & { schoolId: string | null }, action: string, entity: string, entityId?: string | null, meta?: unknown) {
  try {
    await ctx.db.insert(auditLogs).values({
      schoolId: ctx.schoolId,
      userId: ctx.userId,
      action,
      entity,
      entityId: entityId ?? null,
      meta: meta ?? null,
    });
  } catch (err) {
    console.error('audit failed', err);
  }
}
