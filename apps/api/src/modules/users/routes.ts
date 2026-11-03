/** Users (staff accounts, portal logins) and configurable roles. */
import { z } from 'zod';
import { and, asc, count, eq, ilike, or, sql, inArray } from 'drizzle-orm';
import { ALL_PERMISSIONS, DATA_SCOPES } from '@edumin/shared';
import { roles, staffProfiles, users } from '../../db/schema';
import { badRequest, conflict, forbidden, must } from '../../core/errors';
import { ctxOf, guard, idParam, ok, optDate, optStr, pageQuery, typed, type App } from '../../core/http';
import { hashPassword } from '../../core/auth';
import { audit } from '../../core/audit';
import type { Ctx } from '../../core/context';

const STAFF_ROLE_EXCLUDE = sql`${roles.key} not in ('student','parent')`;

async function roleInSchool(ctx: Ctx, roleId: string) {
  const [r] = await ctx.db.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.schoolId, ctx.schoolId)));
  return must(r, 'Role');
}

const staffBody = z.object({
  fullName: z.string().trim().min(2).max(200),
  email: z.email().transform((v) => v.toLowerCase()),
  phone: optStr,
  roleId: z.uuid(),
  password: z.string().min(8).optional(),
  isActive: z.boolean().default(true),
  employeeCode: optStr,
  designation: optStr,
  department: optStr,
  qualification: optStr,
  joinDate: optDate,
  gender: optStr,
  address: optStr,
});

export async function userRoutes(app: App) {
  const r = typed(app);

  // ── Staff directory (teachers, accountants, admins, principal, custom staff roles) ──
  r.get(
    '/staff',
    { preValidation: guard('staff.view'), schema: { tags: ['Staff'], querystring: pageQuery.extend({ roleKey: z.string().optional(), active: z.enum(['true', 'false']).optional() }) } },
    async (req) => {
      const ctx = ctxOf(req);
      const { page, pageSize, search, roleKey, active } = req.query;
      const where = and(
        eq(users.schoolId, ctx.schoolId),
        STAFF_ROLE_EXCLUDE,
        roleKey ? eq(roles.key, roleKey) : undefined,
        active ? eq(users.isActive, active === 'true') : undefined,
        search ? or(ilike(users.fullName, `%${search}%`), ilike(users.email, `%${search}%`), ilike(staffProfiles.employeeCode, `%${search}%`)) : undefined,
      );
      const rows = await ctx.db
        .select({
          id: users.id,
          fullName: users.fullName,
          email: users.email,
          phone: users.phone,
          avatarUrl: users.avatarUrl,
          isActive: users.isActive,
          lastLoginAt: users.lastLoginAt,
          roleId: roles.id,
          roleName: roles.name,
          roleKey: roles.key,
          employeeCode: staffProfiles.employeeCode,
          designation: staffProfiles.designation,
          department: staffProfiles.department,
          qualification: staffProfiles.qualification,
          joinDate: staffProfiles.joinDate,
          gender: staffProfiles.gender,
          address: staffProfiles.address,
        })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
        .where(where)
        .orderBy(asc(users.fullName))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [{ n }] = await ctx.db
        .select({ n: count() })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
        .where(where);
      return ok(rows, { page, pageSize, total: n });
    },
  );

  /** Lightweight teacher list for dropdowns — any staff member can read it. */
  r.get('/staff/teachers', { schema: { tags: ['Staff'] } }, async (req) => {
    const ctx = ctxOf(req);
    const rows = await ctx.db
      .select({ id: users.id, fullName: users.fullName, roleKey: roles.key })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.schoolId, ctx.schoolId), eq(users.isActive, true), inArray(roles.key, ['teacher', 'principal', 'school_admin'])))
      .orderBy(asc(users.fullName));
    return ok(rows);
  });

  r.post('/staff', { preValidation: guard('staff.create'), schema: { tags: ['Staff'], body: staffBody.extend({ password: z.string().min(8) }) } }, async (req) => {
    const ctx = ctxOf(req);
    const b = req.body;
    const role = await roleInSchool(ctx, b.roleId);
    if (['student', 'parent'].includes(role.key)) throw badRequest('Use the student/guardian screens to create portal accounts');
    const user = await ctx.db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ schoolId: ctx.schoolId, roleId: role.id, email: b.email, fullName: b.fullName, phone: b.phone, isActive: b.isActive, passwordHash: await hashPassword(b.password) })
        .returning();
      await tx.insert(staffProfiles).values({
        userId: u.id,
        schoolId: ctx.schoolId,
        employeeCode: b.employeeCode,
        designation: b.designation,
        department: b.department,
        qualification: b.qualification,
        joinDate: b.joinDate,
        gender: b.gender,
        address: b.address,
      });
      return u;
    });
    await audit(ctx, 'create', 'staff', user.id);
    return ok({ id: user.id });
  });

  r.put('/staff/:id', { preValidation: guard('staff.edit'), schema: { tags: ['Staff'], params: idParam, body: staffBody } }, async (req) => {
    const ctx = ctxOf(req);
    const b = req.body;
    const role = await roleInSchool(ctx, b.roleId);
    if (['student', 'parent'].includes(role.key)) throw badRequest('Invalid role for staff');
    if (req.params.id === ctx.userId && !b.isActive) throw badRequest('You cannot deactivate your own account');
    await ctx.db.transaction(async (tx) => {
      const [u] = await tx
        .update(users)
        .set({
          email: b.email,
          fullName: b.fullName,
          phone: b.phone,
          roleId: role.id,
          isActive: b.isActive,
          ...(b.password ? { passwordHash: await hashPassword(b.password), tokenVersion: sql`${users.tokenVersion} + 1` } : {}),
        })
        .where(and(eq(users.id, req.params.id), eq(users.schoolId, ctx.schoolId)))
        .returning();
      must(u, 'Staff member');
      const profile = {
        employeeCode: b.employeeCode,
        designation: b.designation,
        department: b.department,
        qualification: b.qualification,
        joinDate: b.joinDate,
        gender: b.gender,
        address: b.address,
      };
      await tx
        .insert(staffProfiles)
        .values({ userId: u.id, schoolId: ctx.schoolId, ...profile })
        .onConflictDoUpdate({ target: staffProfiles.userId, set: profile });
    });
    await audit(ctx, 'update', 'staff', req.params.id);
    return ok({ updated: true });
  });

  r.delete('/staff/:id', { preValidation: guard('staff.delete'), schema: { tags: ['Staff'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    if (req.params.id === ctx.userId) throw badRequest('You cannot remove your own account');
    // Soft-delete: keep the account for historical references (marks entered, receipts issued...).
    const [u] = await ctx.db
      .update(users)
      .set({ isActive: false, tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(and(eq(users.id, req.params.id), eq(users.schoolId, ctx.schoolId)))
      .returning({ id: users.id });
    must(u, 'Staff member');
    await audit(ctx, 'deactivate', 'staff', u.id);
    return ok({ deactivated: true });
  });

  // ── Roles & permissions ──
  r.get('/roles', { preValidation: guard('users.view'), schema: { tags: ['Roles'] } }, async (req) => {
    const ctx = ctxOf(req);
    const rows = await ctx.db
      .select({ role: roles, userCount: sql<number>`(select count(*)::int from ${users} where ${users.roleId} = ${roles.id} and ${users.isActive})` })
      .from(roles)
      .where(eq(roles.schoolId, ctx.schoolId))
      .orderBy(asc(roles.createdAt));
    return ok(rows.map((r) => ({ ...r.role, userCount: r.userCount })));
  });

  const roleBody = z.object({
    name: z.string().trim().min(2).max(100),
    description: optStr,
    scope: z.enum(DATA_SCOPES),
    permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])),
  });

  r.post('/roles', { preValidation: guard('users.create'), schema: { tags: ['Roles'], body: roleBody } }, async (req) => {
    const ctx = ctxOf(req);
    const key = 'custom_' + req.body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
    const [dupe] = await ctx.db.select({ id: roles.id }).from(roles).where(and(eq(roles.schoolId, ctx.schoolId), eq(roles.key, key)));
    if (dupe) throw conflict('A role with this name already exists');
    const [row] = await ctx.db.insert(roles).values({ ...req.body, key, schoolId: ctx.schoolId, isSystem: false }).returning();
    await audit(ctx, 'create', 'role', row.id);
    return ok(row);
  });

  r.put('/roles/:id', { preValidation: guard('users.edit'), schema: { tags: ['Roles'], params: idParam, body: roleBody } }, async (req) => {
    const ctx = ctxOf(req);
    const role = await roleInSchool(ctx, req.params.id);
    // Guard rails: the school admin role always keeps full access, and system roles keep their scope.
    if (role.key === 'school_admin') throw forbidden('The School Admin role cannot be modified');
    const patch = role.isSystem ? { permissions: req.body.permissions, description: req.body.description } : req.body;
    const [row] = await ctx.db.update(roles).set(patch).where(eq(roles.id, role.id)).returning();
    await audit(ctx, 'update', 'role', row.id, { permissions: row.permissions.length });
    return ok(row);
  });

  r.delete('/roles/:id', { preValidation: guard('users.delete'), schema: { tags: ['Roles'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    const role = await roleInSchool(ctx, req.params.id);
    if (role.isSystem) throw forbidden('System roles cannot be deleted');
    const [{ n }] = await ctx.db.select({ n: count() }).from(users).where(eq(users.roleId, role.id));
    if (n) throw conflict(`${n} user(s) still have this role`);
    await ctx.db.delete(roles).where(eq(roles.id, role.id));
    return ok({ deleted: true });
  });
}
