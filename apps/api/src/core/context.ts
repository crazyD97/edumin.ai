/**
 * The service context: who is calling, for which school, with what rights.
 *
 * Every service function takes a `Ctx` as its first argument. HTTP routes build
 * it from the authenticated request; a future MCP server would build it the
 * same way from its own session. Business logic never reads the request.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { ALL_FEATURES, ALL_PERMISSIONS, type DataScope, type FeatureKey, type Permission } from '@edumin/shared';
import { db as rootDb, type Executor } from './db';
import { academicYears, enrollments, guardians, sectionSubjects, sections, studentGuardians, students, timetableEntries } from '../db/schema';
import { forbidden } from './errors';

export interface Ctx {
  db: Executor;
  userId: string;
  schoolId: string;
  roleKey: string;
  scope: DataScope;
  permissions: Set<string>;
  features: Set<string>;
  /** Per-request memo for scope lookups. */
  cache: Map<string, unknown>;
}

export interface PlatformCtx {
  db: Executor;
  userId: string;
}

export function createCtx(init: Omit<Ctx, 'cache' | 'db'> & { db?: Executor }): Ctx {
  return { db: rootDb, ...init, cache: new Map() };
}

/** Same caller, different executor — used to run a service inside a transaction. */
export const withTx = (ctx: Ctx, tx: Executor): Ctx => ({ ...ctx, db: tx });

export const can = (ctx: Ctx, perm: Permission) => ctx.permissions.has(perm);

export function requirePermission(ctx: Ctx, ...perms: Permission[]) {
  for (const p of perms) if (!ctx.permissions.has(p)) throw forbidden(`Missing permission: ${p}`);
}

export function requireFeature(ctx: Ctx, feature: FeatureKey) {
  if (!ctx.features.has(feature)) {
    throw forbidden(`The "${feature}" module is not enabled for your school's plan`);
  }
}

async function memo<T>(ctx: Ctx, key: string, fn: () => Promise<T>): Promise<T> {
  if (ctx.cache.has(key)) return ctx.cache.get(key) as T;
  const v = await fn();
  ctx.cache.set(key, v);
  return v;
}

export function currentYearId(ctx: Ctx): Promise<string | null> {
  return memo(ctx, 'currentYear', async () => {
    const [y] = await ctx.db
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(and(eq(academicYears.schoolId, ctx.schoolId), eq(academicYears.isCurrent, true)))
      .limit(1);
    return y?.id ?? null;
  });
}

/** Students the caller personally relates to: themself (student) or their children (parent). */
export function ownStudentIds(ctx: Ctx): Promise<string[]> {
  return memo(ctx, 'ownStudents', async () => {
    const self = await ctx.db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.schoolId, ctx.schoolId), eq(students.userId, ctx.userId)));
    const children = await ctx.db
      .select({ id: studentGuardians.studentId })
      .from(studentGuardians)
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .where(and(eq(guardians.schoolId, ctx.schoolId), eq(guardians.userId, ctx.userId)));
    return [...new Set([...self, ...children].map((r) => r.id))];
  });
}

/** Sections a teacher is attached to: class teacher, subject teacher, or on the timetable. */
export function teacherSectionIds(ctx: Ctx, userId = ctx.userId): Promise<string[]> {
  return memo(ctx, `teacherSections:${userId}`, async () => {
    const a = await ctx.db
      .select({ id: sections.id })
      .from(sections)
      .where(and(eq(sections.schoolId, ctx.schoolId), eq(sections.classTeacherId, userId)));
    const b = await ctx.db
      .select({ id: sectionSubjects.sectionId })
      .from(sectionSubjects)
      .where(and(eq(sectionSubjects.schoolId, ctx.schoolId), eq(sectionSubjects.teacherId, userId)));
    const c = await ctx.db
      .select({ id: timetableEntries.sectionId })
      .from(timetableEntries)
      .where(and(eq(timetableEntries.schoolId, ctx.schoolId), eq(timetableEntries.teacherId, userId)));
    return [...new Set([...a, ...b, ...c].map((r) => r.id))];
  });
}

/**
 * Section ids visible to the caller, or `null` meaning "all sections in the school".
 */
export function scopedSectionIds(ctx: Ctx): Promise<string[] | null> {
  return memo(ctx, 'scopedSections', async () => {
    if (ctx.scope === 'school') return null;
    if (ctx.scope === 'assigned') return teacherSectionIds(ctx);
    const ids = await ownStudentIds(ctx);
    if (!ids.length) return [];
    const rows = await ctx.db
      .select({ id: enrollments.sectionId })
      .from(enrollments)
      .where(and(eq(enrollments.schoolId, ctx.schoolId), inArray(enrollments.studentId, ids)));
    return [...new Set(rows.map((r) => r.id))];
  });
}

/**
 * Student ids visible to the caller, or `null` meaning "all students in the school".
 * Teachers see students ever enrolled in their sections (history included).
 */
export function scopedStudentIds(ctx: Ctx): Promise<string[] | null> {
  return memo(ctx, 'scopedStudents', async () => {
    if (ctx.scope === 'school') return null;
    if (ctx.scope === 'own') return ownStudentIds(ctx);
    const secIds = await teacherSectionIds(ctx);
    if (!secIds.length) return [];
    const rows = await ctx.db
      .select({ id: enrollments.studentId })
      .from(enrollments)
      .where(and(eq(enrollments.schoolId, ctx.schoolId), inArray(enrollments.sectionId, secIds)));
    return [...new Set(rows.map((r) => r.id))];
  });
}

export async function assertStudentAccess(ctx: Ctx, studentId: string) {
  const ids = await scopedStudentIds(ctx);
  if (ids && !ids.includes(studentId)) throw forbidden('This student is outside your access scope');
}

export async function assertSectionAccess(ctx: Ctx, sectionId: string) {
  const ids = await scopedSectionIds(ctx);
  if (ids && !ids.includes(sectionId)) throw forbidden('This class section is outside your access scope');
}

/** Teachers may only act on sections they're attached to; school-scope roles on any. */
export async function assertCanTeachSection(ctx: Ctx, sectionId: string) {
  if (ctx.scope === 'school') return;
  if (ctx.scope === 'own') throw forbidden();
  const ids = await teacherSectionIds(ctx);
  if (!ids.includes(sectionId)) throw forbidden('You are not assigned to this class section');
}


/**
 * Context for background work done on a school's behalf (delivery jobs,
 * rendering attachments). Never built from a request.
 */
export function systemCtx(schoolId: string): Ctx {
  return createCtx({
    userId: '00000000-0000-0000-0000-000000000000',
    schoolId,
    roleKey: 'system',
    scope: 'school',
    permissions: new Set(ALL_PERMISSIONS),
    features: new Set(ALL_FEATURES),
  });
}
