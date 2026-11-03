/**
 * Demo seed: plans, a platform admin and two schools with realistic data.
 * Safe to re-run: it wipes and recreates everything (development only).
 *
 *   Platform admin:  admin@edumin.app / Admin@123            (no school)
 *   Greenwood admin: admin@greenwood.edu / Password@123      (school: greenwood)
 *   Teacher:         priya.nair@greenwood.edu / Password@123
 *   Accountant:      accounts@greenwood.edu / Password@123
 *   Principal:       principal@greenwood.edu / Password@123
 *   Parent:          parent@greenwood.edu / Password@123
 *   Student:         student@greenwood.edu / Password@123
 *   Riverside admin: admin@riverside.edu / Password@123      (school: riverside)
 */
import { sql } from 'drizzle-orm';
import { ALL_FEATURES } from '@edumin/shared';
import { db, sqlClient } from '../core/db';
import { plans, users } from './schema';
import { hashPassword } from '../core/auth';
import { runMigrations } from './migrate';
import { provisionSchool } from '../modules/platform/provision';
import { seedSchoolData } from './seed-data';
import { env } from '../core/env';

if (env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');

await runMigrations();
console.log('Resetting data…');
const tables = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
const names = (tables as unknown as { tablename: string }[]).map((t) => `"${t.tablename}"`).join(', ');
if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));

const [starter, growth] = await db
  .insert(plans)
  .values([
    {
      code: 'starter',
      name: 'Starter',
      description: 'Core school operations for small schools',
      priceMonthly: 2999,
      priceYearly: 29990,
      maxStudents: 300,
      maxStaff: 30,
      features: ['admissions', 'attendance', 'fees', 'communication', 'events'],
    },
    {
      code: 'growth',
      name: 'Growth',
      description: 'Full academic suite for growing schools',
      priceMonthly: 6999,
      priceYearly: 69990,
      maxStudents: 1500,
      maxStaff: 150,
      features: ALL_FEATURES.filter((f) => f !== 'custom_domain'),
    },
    {
      code: 'enterprise',
      name: 'Enterprise',
      description: 'Unlimited, white-label, priority support',
      priceMonthly: 14999,
      priceYearly: 149990,
      features: ALL_FEATURES,
    },
  ])
  .returning();

await db.insert(users).values({
  email: 'admin@edumin.app',
  fullName: 'Platform Owner',
  passwordHash: await hashPassword('Admin@123'),
  isPlatformAdmin: true,
});

const greenwood = await provisionSchool(db, {
  name: 'Greenwood International School',
  slug: 'greenwood',
  planId: growth.id,
  status: 'active',
  branding: {
    primaryColor: '#0f766e',
    secondaryColor: '#0f172a',
    accentColor: '#f59e0b',
    email: 'office@greenwood.edu',
    phone: '+91 80 4123 4567',
    address: '12 Lakeview Road, Bengaluru 560001',
    website: 'https://greenwood.edu',
    loginTitle: 'Welcome to Greenwood',
    loginSubtitle: 'Nurturing curious minds since 1998',
    reportCardFooter: 'This is a computer-generated report card.',
    receiptFooter: 'Fees once paid are non-refundable. Thank you!',
    principalName: 'Dr. Meera Iyer',
  },
  admin: { fullName: 'Anita Desai', email: 'admin@greenwood.edu', password: 'Password@123' },
});
await seedSchoolData(greenwood.school.id, { size: 'large' });

const riverside = await provisionSchool(db, {
  name: 'Riverside Academy',
  slug: 'riverside',
  planId: starter.id,
  status: 'trial',
  trialDays: 21,
  branding: { primaryColor: '#7c3aed', secondaryColor: '#1e1b4b', accentColor: '#ec4899', email: 'hello@riverside.edu', loginTitle: 'Riverside Academy Portal' },
  admin: { fullName: 'Rahul Menon', email: 'admin@riverside.edu', password: 'Password@123' },
});
await seedSchoolData(riverside.school.id, { size: 'small' });

console.log('Seed complete.');
console.log('  Platform admin  admin@edumin.app / Admin@123');
console.log('  Greenwood       admin@greenwood.edu / Password@123   (school code: greenwood)');
console.log('  Riverside       admin@riverside.edu / Password@123   (school code: riverside)');
await sqlClient.end();
