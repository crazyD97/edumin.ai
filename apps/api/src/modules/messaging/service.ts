/**
 * Outbound messaging: decides which channels an event goes out on, reserves
 * message credits, queues one row per recipient per channel, and a job
 * delivers the queue through the providers.
 */
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { CHANNELS, CREDIT_COST, normalizeIndianMobile, type Channel, type MessageEvent, type MessagingSettings } from '@edumin/shared';
import { db as rootDb, type Executor } from '../../core/db';
import { creditTransactions, guardians, notifications, outboundMessages, plans, schools, studentGuardians, students, users } from '../../db/schema';
import { effectiveFeatures } from '../../core/http';
import { publicUrl } from '../../core/env';
import { signLink } from '../../core/crypto';
import { renderTemplate } from './templates';
import { providers } from './providers';

export interface Recipient {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  studentId?: string | null;
  userId?: string | null;
}

export interface AttachmentRef {
  kind: 'receipt' | 'report_card';
  ref: Record<string, string>;
  filename: string;
}

export interface DispatchItem {
  recipient: Recipient;
  vars: Record<string, string | number | null | undefined>;
  attachment?: AttachmentRef | null;
}

export interface DispatchOptions {
  event: MessageEvent;
  items: DispatchItem[];
  createdBy?: string | null;
  /** Manual sends pick channels explicitly instead of using the school's event settings. */
  channels?: Channel[];
}

export interface DispatchResult {
  queued: number;
  skipped: number;
  credits: number;
  byChannel: Partial<Record<Channel, number>>;
  reason?: string;
}

async function schoolMessagingState(db: Executor, schoolId: string) {
  const [row] = await db.select({ school: schools, plan: plans }).from(schools).leftJoin(plans, eq(plans.id, schools.planId)).where(eq(schools.id, schoolId));
  if (!row) return null;
  return { school: row.school, features: new Set(effectiveFeatures(row.school, row.plan)) };
}

/** Channels an event will actually use for a school right now. */
export function activeChannels(settings: MessagingSettings, features: Set<string>, event: MessageEvent, override?: Channel[]) {
  const wanted = override ?? settings.events[event] ?? [];
  return CHANNELS.filter((c) => wanted.includes(c) && settings.channels[c] && (c === 'email' || features.has('messaging')));
}

/** Atomically takes `n` credits; returns the new balance or null when there aren't enough. */
export async function reserveCredits(db: Executor, schoolId: string, n: number) {
  const [row] = await db
    .update(schools)
    .set({ messageCredits: sql`${schools.messageCredits} - ${n}` })
    .where(and(eq(schools.id, schoolId), gte(schools.messageCredits, n)))
    .returning({ balance: schools.messageCredits });
  return row?.balance ?? null;
}

export async function addCredits(db: Executor, schoolId: string, delta: number, entry: { kind: string; note?: string | null; amountPaid?: number | null; reference?: string | null; createdBy?: string | null }) {
  const [row] = await db
    .update(schools)
    .set({ messageCredits: sql`${schools.messageCredits} + ${delta}` })
    .where(eq(schools.id, schoolId))
    .returning({ balance: schools.messageCredits });
  await db.insert(creditTransactions).values({ schoolId, delta, balanceAfter: row.balance, kind: entry.kind, note: entry.note ?? null, amountPaid: entry.amountPaid ?? null, reference: entry.reference ?? null, createdBy: entry.createdBy ?? null });
  return row.balance;
}

/** Warn school admins (at most once a day) when credits run low or out. */
async function warnLowCredits(db: Executor, schoolId: string, balance: number, ranOut: boolean) {
  const [recent] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.schoolId, schoolId), eq(notifications.type, 'credits_low'), sql`${notifications.createdAt} > now() - interval '1 day'`))
    .limit(1);
  if (recent) return;
  const admins = await db.execute<{ id: string }>(
    sql`select u.id from users u join roles r on r.id = u.role_id where u.school_id = ${schoolId} and u.is_active and r.key in ('school_admin','principal','accountant')`,
  );
  const ids = (admins as unknown as { id: string }[]).map((a) => a.id);
  if (!ids.length) return;
  await db.insert(notifications).values(
    ids.map((userId) => ({
      schoolId,
      userId,
      type: 'credits_low',
      title: ranOut ? 'WhatsApp/SMS messages were not sent — out of credits' : `Message credits running low (${balance} left)`,
      body: 'Buy a credit pack to keep parent alerts flowing.',
      link: '/messaging',
    })),
  );
}

/**
 * Queues messages for an event. In-app notifications are handled separately;
 * this only covers email/WhatsApp/SMS.
 */
export async function dispatch(db: Executor, schoolId: string, opts: DispatchOptions): Promise<DispatchResult> {
  const result: DispatchResult = { queued: 0, skipped: 0, credits: 0, byChannel: {} };
  if (!opts.items.length) return result;
  const state = await schoolMessagingState(db, schoolId);
  if (!state) return result;
  const channels = activeChannels(state.school.messaging, state.features, opts.event, opts.channels);
  if (!channels.length) return { ...result, reason: 'No channel is enabled for this event' };

  const rows: (typeof outboundMessages.$inferInsert)[] = [];
  const seen = new Set<string>();
  for (const item of opts.items) {
    const content = renderTemplate(opts.event, { school: state.school.name, ...item.vars });
    for (const channel of channels) {
      const to = channel === 'email' ? item.recipient.email?.trim().toLowerCase() || null : normalizeIndianMobile(item.recipient.phone);
      if (!to) continue;
      const key = `${channel}|${to}|${content.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        schoolId,
        channel,
        event: opts.event,
        recipient: to,
        recipientName: item.recipient.name ?? null,
        studentId: item.recipient.studentId ?? null,
        userId: item.recipient.userId ?? null,
        subject: content.subject,
        body: content.text,
        params: content.params,
        attachment: item.attachment ?? null,
        credits: CREDIT_COST[channel],
        createdBy: opts.createdBy ?? null,
      });
    }
  }
  if (!rows.length) return { ...result, reason: 'Recipients have no phone number or email on record' };

  const paid = rows.filter((r) => r.credits! > 0);
  const needed = paid.reduce((a, r) => a + r.credits!, 0);
  if (needed > 0) {
    const balance = await reserveCredits(db, schoolId, needed);
    if (balance === null) {
      for (const r of paid) Object.assign(r, { status: 'skipped', error: 'Not enough message credits', credits: 0 });
      result.reason = 'Not enough message credits for WhatsApp/SMS';
      await warnLowCredits(db, schoolId, state.school.messageCredits, true);
    } else {
      result.credits = needed;
      const counts = paid.reduce<Record<string, number>>((a, r) => ((a[r.channel] = (a[r.channel] ?? 0) + 1), a), {});
      await db.insert(creditTransactions).values({
        schoolId,
        delta: -needed,
        balanceAfter: balance,
        kind: 'usage',
        note: `${Object.entries(counts).map(([c, n]) => `${n} ${c}`).join(', ')} · ${opts.event.replace(/_/g, ' ')}`,
        createdBy: opts.createdBy ?? null,
      });
      if (balance < state.school.messaging.lowCreditAlert) await warnLowCredits(db, schoolId, balance, false);
    }
  }
  for (let i = 0; i < rows.length; i += 500) await db.insert(outboundMessages).values(rows.slice(i, i + 500));
  for (const r of rows) {
    if (r.status === 'skipped') result.skipped++;
    else {
      result.queued++;
      result.byChannel[r.channel as Channel] = (result.byChannel[r.channel as Channel] ?? 0) + 1;
    }
  }
  return result;
}

// ── Recipient helpers ──

/** The primary guardian (or first guardian) of each student, with the student's name. */
export async function familyRecipients(db: Executor, schoolId: string, studentIds: string[]) {
  if (!studentIds.length) return new Map<string, Recipient & { studentName: string }>();
  const rows = await db
    .select({
      studentId: students.id,
      studentName: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
      name: guardians.name,
      phone: guardians.phone,
      email: guardians.email,
      userId: guardians.userId,
      isPrimary: studentGuardians.isPrimary,
    })
    .from(students)
    .innerJoin(studentGuardians, eq(studentGuardians.studentId, students.id))
    .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .where(and(eq(students.schoolId, schoolId), inArray(students.id, studentIds)))
    .orderBy(desc(studentGuardians.isPrimary));
  const out = new Map<string, Recipient & { studentName: string }>();
  for (const r of rows) if (!out.has(r.studentId)) out.set(r.studentId, { ...r, studentName: r.studentName.trim() });
  return out;
}

export async function userRecipients(db: Executor, userIds: string[]): Promise<Recipient[]> {
  if (!userIds.length) return [];
  const rows = await db.select({ userId: users.id, name: users.fullName, phone: users.phone, email: users.email }).from(users).where(inArray(users.id, userIds));
  return rows;
}

// ── Delivery job ──

async function renderAttachment(schoolId: string, a: AttachmentRef): Promise<Buffer> {
  const { systemCtx } = await import('../../core/context');
  const ctx = systemCtx(schoolId);
  if (a.kind === 'receipt') return (await (await import('../fees/service')).receiptPdf(ctx, a.ref.paymentId)).buffer;
  return (await (await import('../exams/service')).reportCardPdf(ctx, a.ref.examId, { studentId: a.ref.studentId })).buffer;
}

export function attachmentUrl(messageId: string) {
  const { exp, sig } = signLink(`msg:${messageId}`);
  return `${publicUrl()}/api/public/messages/${messageId}/attachment?exp=${exp}&sig=${sig}`;
}

export async function renderMessageAttachment(messageId: string) {
  const [m] = await rootDb.select().from(outboundMessages).where(eq(outboundMessages.id, messageId));
  if (!m?.attachment || !m.schoolId) return null;
  return { buffer: await renderAttachment(m.schoolId, m.attachment as AttachmentRef), filename: m.attachment.filename };
}

const MAX_ATTEMPTS = 3;

export async function deliverQueued(limit = 50) {
  const queued = await rootDb.select().from(outboundMessages).where(eq(outboundMessages.status, 'queued')).orderBy(asc(outboundMessages.createdAt)).limit(limit);
  for (const m of queued) {
    try {
      const attachment = m.attachment && m.schoolId ? { filename: m.attachment.filename, url: attachmentUrl(m.id), buffer: await renderAttachment(m.schoolId, m.attachment as AttachmentRef) } : null;
      const res = await providers[m.channel as Channel].send({
        event: m.event as MessageEvent,
        to: m.recipient,
        subject: m.subject ?? '',
        text: m.body,
        params: m.params,
        whatsappTemplate: renderTemplate(m.event as MessageEvent, {}).whatsappTemplate,
        attachment,
      });
      const now = new Date();
      await rootDb
        .update(outboundMessages)
        .set({ status: res.simulated ? 'delivered' : 'sent', providerRef: res.ref, sentAt: now, deliveredAt: res.simulated ? now : null, attempts: m.attempts + 1, error: null })
        .where(eq(outboundMessages.id, m.id));
    } catch (err) {
      const attempts = m.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      await rootDb.update(outboundMessages).set({ status: failed ? 'failed' : 'queued', attempts, error: String((err as Error).message ?? err).slice(0, 500) }).where(eq(outboundMessages.id, m.id));
      if (failed && m.credits > 0 && m.schoolId) await addCredits(rootDb, m.schoolId, m.credits, { kind: 'refund', note: `Refund: undelivered ${m.channel} to ${m.recipient}`, reference: m.id });
    }
  }
  return queued.length;
}

/** Status callbacks from WhatsApp (sent → delivered → read, or failed). */
export async function applyDeliveryStatus(providerRef: string, status: string, error?: string | null) {
  const map: Record<string, string> = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
  const next = map[status];
  if (!next) return;
  const [m] = await rootDb.select().from(outboundMessages).where(eq(outboundMessages.providerRef, providerRef));
  if (!m) return;
  const order = ['queued', 'sent', 'delivered', 'read'];
  if (next !== 'failed' && order.indexOf(next) <= order.indexOf(m.status)) return; // callbacks can arrive out of order
  await rootDb
    .update(outboundMessages)
    .set({ status: next, deliveredAt: next === 'delivered' || next === 'read' ? (m.deliveredAt ?? new Date()) : m.deliveredAt, error: error ?? m.error })
    .where(eq(outboundMessages.id, m.id));
  if (next === 'failed' && m.status !== 'failed' && m.credits > 0 && m.schoolId) {
    await addCredits(rootDb, m.schoolId, m.credits, { kind: 'refund', note: `Refund: WhatsApp reported failure to ${m.recipient}`, reference: m.id });
  }
}
