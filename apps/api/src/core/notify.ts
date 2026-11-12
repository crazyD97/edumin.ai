/**
 * Notification fan-out. Every notification is stored in-app (and pushed to the
 * installed app); with `deliver`, it also goes out over the email/WhatsApp/SMS
 * channels the school has enabled for that event.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { MessageEvent } from '@edumin/shared';
import type { Executor } from './db';
import { enrollments, guardians, notifications, roles, sections, studentGuardians, students, users } from '../db/schema';
import { pushToUsers } from './push';
import { dispatch, familyRecipients, userRecipients, type AttachmentRef, type DispatchResult } from '../modules/messaging/service';

type Vars = Record<string, string | number | null | undefined>;

export interface NotifyInput {
  type: string;
  title: string;
  body?: string;
  link?: string;
  /** Also send outside the app on this event's channels. */
  deliver?: { event: MessageEvent; vars?: Vars };
  createdBy?: string | null;
}

async function inApp(db: Executor, schoolId: string | null, ids: string[], input: NotifyInput) {
  for (let i = 0; i < ids.length; i += 500) {
    await db.insert(notifications).values(
      ids.slice(i, i + 500).map((userId) => ({ schoolId, userId, type: input.type, title: input.title, body: input.body ?? null, link: input.link ?? null })),
    );
  }
  pushToUsers(ids, { title: input.title, body: input.body ?? '', link: input.link ?? '/' }).catch(() => {});
}

export async function notifyUsers(db: Executor, schoolId: string | null, userIds: string[], input: NotifyInput) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  await inApp(db, schoolId, ids, input);
  if (input.deliver && schoolId) {
    const recipients = await userRecipients(db, ids);
    await dispatch(db, schoolId, {
      event: input.deliver.event,
      createdBy: input.createdBy,
      items: recipients.map((r) => ({ recipient: r, vars: { name: r.name, ...input.deliver!.vars } })),
    });
  }
  return ids.length;
}

/**
 * Notifies the families of students: in-app to student and parent accounts, and
 * out-of-app to each student's primary guardian (whether or not they have a login).
 */
export async function notifyFamilies(
  db: Executor,
  schoolId: string,
  studentIds: string[],
  input: Omit<NotifyInput, 'deliver'> & {
    event: MessageEvent;
    vars?: Vars | ((student: { id: string; name: string }) => Vars);
    attachment?: (studentId: string) => AttachmentRef | null;
    /** In-app recipients: parents, students, or both (default). */
    who?: { students?: boolean; parents?: boolean };
  },
): Promise<DispatchResult | null> {
  const unique = [...new Set(studentIds)];
  if (!unique.length) return null;
  await inApp(db, schoolId, await audience.forStudents(db, schoolId, unique, input.who ?? { students: true, parents: true }), input);
  const families = await familyRecipients(db, schoolId, unique);
  return dispatch(db, schoolId, {
    event: input.event,
    createdBy: input.createdBy,
    items: [...families.entries()].map(([studentId, r]) => ({
      recipient: r,
      vars: { student: r.studentName, ...(typeof input.vars === 'function' ? input.vars({ id: studentId, name: r.studentName }) : input.vars) },
      attachment: input.attachment?.(studentId) ?? null,
    })),
  });
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

