/** Creates a fully usable tenant: school row, default roles, admin user, starter config. */
import { DEFAULT_BRANDING, DEFAULT_ROLES, DEFAULT_SETTINGS, SYSTEM_ROLES, type Branding } from '@edumin/shared';
import type { Executor } from '../../core/db';
import { academicYears, feeHeads, gradingScales, periods, roles, schools, users } from '../../db/schema';
import { hashPassword } from '../../core/auth';

export interface ProvisionInput {
  name: string;
  slug: string;
  planId?: string | null;
  status?: 'trial' | 'active';
  trialDays?: number;
  branding?: Partial<Branding>;
  admin: { fullName: string; email: string; password: string };
}

export const DEFAULT_GRADE_BANDS = [
  { grade: 'A+', min: 90, point: 10, remark: 'Outstanding' },
  { grade: 'A', min: 80, point: 9, remark: 'Excellent' },
  { grade: 'B+', min: 70, point: 8, remark: 'Very Good' },
  { grade: 'B', min: 60, point: 7, remark: 'Good' },
  { grade: 'C', min: 50, point: 6, remark: 'Above Average' },
  { grade: 'D', min: 40, point: 5, remark: 'Average' },
  { grade: 'E', min: 33, point: 4, remark: 'Pass' },
  { grade: 'F', min: 0, point: 0, remark: 'Needs Improvement' },
];

export function academicYearFor(date = new Date()) {
  // April–March academic year by default; schools can edit.
  const y = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return { name: `${y}-${String(y + 1).slice(2)}`, startDate: `${y}-04-01`, endDate: `${y + 1}-03-31` };
}

export async function provisionSchool(db: Executor, input: ProvisionInput) {
  const trialDays = input.trialDays ?? 30;
  const [school] = await db
    .insert(schools)
    .values({
      name: input.name,
      slug: input.slug.toLowerCase(),
      planId: input.planId ?? null,
      status: input.status ?? 'trial',
      subscriptionStatus: input.status === 'active' ? 'active' : 'trialing',
      trialEndsAt: input.status === 'active' ? null : new Date(Date.now() + trialDays * 86400_000),
      branding: { ...DEFAULT_BRANDING, ...input.branding },
      settings: DEFAULT_SETTINGS,
    })
    .returning();

  const roleRows = await db
    .insert(roles)
    .values(
      SYSTEM_ROLES.map((key) => ({
        schoolId: school.id,
        key,
        name: DEFAULT_ROLES[key].name,
        scope: DEFAULT_ROLES[key].scope,
        permissions: DEFAULT_ROLES[key].permissions,
        isSystem: true,
      })),
    )
    .returning();
  const adminRole = roleRows.find((r) => r.key === 'school_admin')!;

  const [admin] = await db
    .insert(users)
    .values({
      schoolId: school.id,
      roleId: adminRole.id,
      email: input.admin.email.toLowerCase(),
      fullName: input.admin.fullName,
      passwordHash: await hashPassword(input.admin.password),
    })
    .returning();

  await db.insert(academicYears).values({ schoolId: school.id, ...academicYearFor(), isCurrent: true });
  await db.insert(gradingScales).values({ schoolId: school.id, name: 'Standard (Percentage)', passPercent: 33, bands: DEFAULT_GRADE_BANDS, isDefault: true });
  await db.insert(feeHeads).values(['Tuition Fee', 'Admission Fee', 'Transport Fee', 'Examination Fee'].map((name) => ({ schoolId: school.id, name })));
  await db.insert(periods).values([
    { schoolId: school.id, name: 'Period 1', startTime: '08:00', endTime: '08:45', sortOrder: 1 },
    { schoolId: school.id, name: 'Period 2', startTime: '08:45', endTime: '09:30', sortOrder: 2 },
    { schoolId: school.id, name: 'Period 3', startTime: '09:30', endTime: '10:15', sortOrder: 3 },
    { schoolId: school.id, name: 'Break', startTime: '10:15', endTime: '10:35', sortOrder: 4, isBreak: true },
    { schoolId: school.id, name: 'Period 4', startTime: '10:35', endTime: '11:20', sortOrder: 5 },
    { schoolId: school.id, name: 'Period 5', startTime: '11:20', endTime: '12:05', sortOrder: 6 },
    { schoolId: school.id, name: 'Period 6', startTime: '12:05', endTime: '12:50', sortOrder: 7 },
  ]);

  return { school, admin, roles: roleRows };
}
