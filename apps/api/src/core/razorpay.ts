/**
 * Minimal Razorpay client (Orders API + signature checks), used both for a
 * school's own account (fee collection) and the platform account (credits).
 * Docs: https://razorpay.com/docs/api/orders/ · https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/
 */
import { hmacHex, safeEqual } from './crypto';
import { AppError } from './errors';

export interface RazorpayKeys {
  keyId: string;
  keySecret: string;
  webhookSecret?: string;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
}

export async function createOrder(keys: RazorpayKeys, input: { amountInr: number; receipt: string; notes?: Record<string, string> }): Promise<RazorpayOrder> {
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64'),
    },
    body: JSON.stringify({ amount: Math.round(input.amountInr * 100), currency: 'INR', receipt: input.receipt.slice(0, 40), notes: input.notes ?? {} }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new AppError(502, 'GATEWAY_ERROR', `Razorpay: ${body?.error?.description ?? res.statusText}`);
  return body as RazorpayOrder;
}

/** Checkout success callback: signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyPaymentSignature(keySecret: string, orderId: string, paymentId: string, signature: string) {
  return safeEqual(hmacHex(keySecret, `${orderId}|${paymentId}`), signature);
}

/** Webhook: X-Razorpay-Signature = HMAC_SHA256(raw body, webhook secret). */
export function verifyWebhookSignature(webhookSecret: string, rawBody: string, signature: string) {
  return safeEqual(hmacHex(webhookSecret, rawBody), signature);
}

/** Test with a key pair without charging anything (lists one order). */
export async function checkKeys(keys: RazorpayKeys) {
  const res = await fetch('https://api.razorpay.com/v1/orders?count=1', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64') },
  });
  return res.ok;
}
