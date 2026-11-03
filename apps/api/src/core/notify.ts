/**
 * Notification fan-out: in-app notifications plus an email outbox.
 * Email delivery is decoupled — rows are queued and a driver drains them.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Executor } from './db';
import { db as rootDb } from './db';
import { emailOutbox, enrollments, guardians, notifications, roles, sections, studentGuardians, students, users } from '../db/schema';
import { env } from './env';

export interface NotifyInput {
  type: string;
  title: string;
  body?: string;
  link?: string;
  email?: boolean;
}

export async function notifyUsers(db: Executor, schoolId: string | null, userIds: string[], input: NotifyInput) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    await db.insert(notifications).values(
      chunk.map((userId) => ({ schoolId, userId, type: input.type, title: input.title, body: input.body ?? null, link: input.link ?? null })),
    );
    if (input.email) {
      const recipients = await db.select({ email: users.email }).from(users).where(inArray(users.id, chunk));
      if (recipients.length) {
        await db.insert(emailOutbox).values(
          recipients.map((r) => ({ schoolId, to: r.email, subject: input.title, body: `${input.body ?? ''}\n\n${input.link ? env.APP_URL + input.link : ''}` })),
        );
      }
    }
  }
  return ids.length;
}

/** User ids by audience — used by announcements, reminders and alerts. */
export const audience = {
  async byRoleKeys(db: Executor, schoolId: string, keys: string[]) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.schoolId, schoolId), eq(users.isActive, true), inArray(roles.key, keys)));
    return rows.map((r) => r.id);
  },
  async staff(db: Executor, schoolId: string) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(and(eq(users.schoolId, schoolId), eq(users.isActive, true), sql`${roles.key} not in ('student','parent')`));
    return rows.map((r) => r.id);
  },
  /** Login accounts of the given students and of their guardians. */
  async forStudents(db: Executor, schoolId: string, studentIds: string[], who: { students?: boolean; parents?: boolean } = { students: true, parents: true }) {
    if (!studentIds.length) return [];
    const out: string[] = [];
    if (who.students) {
      const s = await db
        .select({ id: students.userId })
        .from(students)
        .where(and(eq(students.schoolId, schoolId), inArray(students.id, studentIds), isNotNull(students.userId)));
      out.push(...s.map((r) => r.id!));
    }
    if (who.parents) {
      const g = await db
        .select({ id: guardians.userId })
        .from(guardians)
        .innerJoin(studentGuardians, eq(studentGuardians.guardianId, guardians.id))
        .where(and(eq(guardians.schoolId, schoolId), inArray(studentGuardians.studentId, studentIds), isNotNull(guardians.userId)));
      out.push(...g.map((r) => r.id!));
    }
    return [...new Set(out)];
  },
  /** Students currently enrolled in any section of the given classes (current year sections). */
  async studentsInClasses(db: Executor, schoolId: string, classIds: string[], academicYearId: string | null) {
    if (!classIds.length || !academicYearId) return [];
    const rows = await db
      .select({ id: enrollments.studentId })
      .from(enrollments)
      .innerJoin(sections, eq(sections.id, enrollments.sectionId))
      .where(and(eq(enrollments.schoolId, schoolId), eq(enrollments.academicYearId, academicYearId), eq(enrollments.status, 'active'), inArray(sections.classId, classIds)));
    return rows.map((r) => r.id);
  },
};

/** Email driver. `console` logs; `smtp` is the integration point for a real provider. */
export async function drainEmailOutbox(limit = 50) {
  if (env.EMAIL_DRIVER === 'none') return 0;
  const queued = await rootDb.select().from(emailOutbox).where(eq(emailOutbox.status, 'queued')).limit(limit);
  for (const mail of queued) {
    try {
      if (env.EMAIL_DRIVER === 'console' && env.NODE_ENV !== 'test') {
        console.log(`[email] to=${mail.to} subject="${mail.subject}"`);
      }
      await rootDb.update(emailOutbox).set({ status: 'sent', sentAt: new Date(), attempts: mail.attempts + 1 }).where(eq(emailOutbox.id, mail.id));
    } catch (err) {
      await rootDb
        .update(emailOutbox)
        .set({ status: mail.attempts >= 4 ? 'failed' : 'queued', attempts: mail.attempts + 1, error: String(err) })
        .where(eq(emailOutbox.id, mail.id));
    }
  }
  return queued.length;
}
