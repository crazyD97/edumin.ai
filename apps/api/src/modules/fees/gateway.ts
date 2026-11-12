/**
 * Online fee payments. Each school connects its own Razorpay account (so fee
 * money settles straight into the school's bank account); without one, the
 * mock gateway is used in development and demos.
 */
import { and, eq } from 'drizzle-orm';
import type { Executor } from '../../core/db';
import { env } from '../../core/env';
import { badRequest } from '../../core/errors';
import { decryptJson } from '../../core/crypto';
import { createOrder, type RazorpayKeys } from '../../core/razorpay';
import { schoolIntegrations } from '../../db/schema';

export interface Checkout {
  gateway: 'razorpay' | 'mock';
  /** Gateway-side order id, stored on the payment for reconciliation. */
  reference: string;
  keyId?: string;
  razorpayOrderId?: string;
  /** Mock gateway only: in-app page that simulates the payer. */
  checkoutUrl: string | null;
}

export async function schoolRazorpay(db: Executor, schoolId: string): Promise<RazorpayKeys | null> {
  const [row] = await db
    .select()
    .from(schoolIntegrations)
    .where(and(eq(schoolIntegrations.schoolId, schoolId), eq(schoolIntegrations.provider, 'razorpay'), eq(schoolIntegrations.enabled, true)));
  const secrets = decryptJson<{ keySecret?: string; webhookSecret?: string }>(row?.secrets);
  if (!row?.config.keyId || !secrets?.keySecret) return null;
  return { keyId: row.config.keyId, keySecret: secrets.keySecret, webhookSecret: secrets.webhookSecret };
}

/** Which gateway this school can take payments through right now (null = none). */
export async function availableGateway(db: Executor, schoolId: string): Promise<Checkout['gateway'] | null> {
  if (await schoolRazorpay(db, schoolId)) return 'razorpay';
  return env.PAYMENT_GATEWAY === 'mock' ? 'mock' : null;
}

export async function createCheckout(db: Executor, schoolId: string, p: { paymentId: string; amount: number; receiptNo: string; studentName: string }): Promise<Checkout> {
  const keys = await schoolRazorpay(db, schoolId);
  if (keys) {
    const order = await createOrder(keys, { amountInr: p.amount, receipt: p.receiptNo, notes: { paymentId: p.paymentId, student: p.studentName } });
    return { gateway: 'razorpay', reference: order.id, keyId: keys.keyId, razorpayOrderId: order.id, checkoutUrl: null };
  }
  if (env.PAYMENT_GATEWAY === 'mock') return { gateway: 'mock', reference: `mock_${p.paymentId.slice(0, 8)}`, checkoutUrl: `/fees/checkout/${p.paymentId}` };
  throw badRequest('Online payment is not set up for this school yet. Please pay at the school office.');
}
