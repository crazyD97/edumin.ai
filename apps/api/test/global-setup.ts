/** Builds a fresh test database: migrations + two small demo schools. */
export default async function setup() {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5433/edumin_test';
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
  process.env.EMAIL_DRIVER = 'none';
  const { sql } = await import('drizzle-orm');
  const { db, sqlClient } = await import('../src/core/db');
  const { runMigrations } = await import('../src/db/migrate');
  const { plans } = await import('../src/db/schema');
  const { provisionSchool } = await import('../src/modules/platform/provision');
  const { seedSchoolData } = await import('../src/db/seed-data');
  const { hashPassword } = await import('../src/core/auth');
  const { users } = await import('../src/db/schema');
  const { ALL_FEATURES } = await import('@edumin/shared');

  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations();
  const [plan] = await db.insert(plans).values({ code: 'all', name: 'All', features: ALL_FEATURES }).returning();
  const [limited] = await db.insert(plans).values({ code: 'basic', name: 'Basic', features: ['attendance'] }).returning();
  await db.insert(users).values({ email: 'root@test.dev', fullName: 'Root', passwordHash: await hashPassword('Root@1234'), isPlatformAdmin: true });
  const a = await provisionSchool(db, { name: 'Alpha School', slug: 'alpha', planId: plan.id, status: 'active', admin: { fullName: 'Alpha Admin', email: 'admin@alpha.test', password: 'Password@123' } });
  await seedSchoolData(a.school.id, { size: 'small' });
  const b = await provisionSchool(db, { name: 'Beta School', slug: 'beta', planId: limited.id, status: 'active', admin: { fullName: 'Beta Admin', email: 'admin@beta.test', password: 'Password@123' } });
  await seedSchoolData(b.school.id, { size: 'small' });
  await sqlClient.end();
}
