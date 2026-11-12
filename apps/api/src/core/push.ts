/**
 * Web Push to the installed app (PWA). No-op until VAPID keys are configured.
 * Subscriptions that the push service reports as gone are removed.
 */
import { inArray, eq } from 'drizzle-orm';
import { sendNotification } from 'web-push';
import { db } from './db';
import { env } from './env';
import { pushSubscriptions } from '../db/schema';

export const pushEnabled = () => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

export async function pushToUsers(userIds: string[], payload: { title: string; body: string; link: string }) {
  if (!pushEnabled() || !userIds.length || env.NODE_ENV === 'test') return;
  const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, userIds));
  const vapidDetails = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! };
  await Promise.all(
    subs.map(async (s) => {
      try {
        await sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { vapidDetails, TTL: 86400 });
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
      }
    }),
  );
}
