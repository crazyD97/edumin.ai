/**
 * Payment gateway abstraction. Add Razorpay/Stripe/etc. by implementing
 * `PaymentGateway` and wiring its webhook to `confirmOnlinePayment`.
 */
import { env } from '../../core/env';

export interface CheckoutResult {
  /** Gateway-side order/session id. */
  reference: string;
  /** Where to send the payer (hosted checkout), or null for client-side SDK flows. */
  checkoutUrl: string | null;
  gateway: string;
}

export interface PaymentGateway {
  name: string;
  createCheckout(input: { paymentId: string; amount: number; description: string }): Promise<CheckoutResult>;
  /** Validates a webhook payload; returns the payment id and outcome. */
  verifyWebhook?(headers: Record<string, string | string[] | undefined>, body: unknown): Promise<{ paymentId: string; success: boolean } | null>;
}

const mockGateway: PaymentGateway = {
  name: 'mock',
  async createCheckout({ paymentId }) {
    return { reference: `mock_${paymentId.slice(0, 8)}`, checkoutUrl: `/fees/checkout/${paymentId}`, gateway: 'mock' };
  },
};

export function getGateway(): PaymentGateway {
  switch (env.PAYMENT_GATEWAY) {
    case 'mock':
      return mockGateway;
    default:
      throw new Error(`Payment gateway "${env.PAYMENT_GATEWAY}" is not implemented yet`);
  }
}
