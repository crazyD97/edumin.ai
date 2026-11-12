/** Razorpay Standard Checkout loader. https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/ */
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (event: string, cb: (r: any) => void) => void };
  }
}

let loading: Promise<void> | null = null;

function loadScript() {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load Razorpay checkout. Check your connection.'));
    };
    document.body.appendChild(s);
  });
  return loading;
}

export interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

/** Opens checkout; resolves with the signed result, or rejects if the payer closes it or the payment fails. */
export async function openRazorpay(opts: { keyId: string; orderId: string; amount: number; name: string; description: string; color?: string; prefill?: { name?: string; email?: string; contact?: string } }) {
  await loadScript();
  return new Promise<RazorpaySuccess>((resolve, reject) => {
    const rzp = new window.Razorpay!({
      key: opts.keyId,
      order_id: opts.orderId,
      amount: Math.round(opts.amount * 100),
      currency: 'INR',
      name: opts.name,
      description: opts.description,
      prefill: opts.prefill,
      theme: { color: opts.color ?? '#4f46e5' },
      handler: (r: RazorpaySuccess) => resolve(r),
      modal: { ondismiss: () => reject(new Error('Payment cancelled')) },
    });
    rzp.on('payment.failed', (r: any) => reject(new Error(r?.error?.description ?? 'Payment failed')));
    rzp.open();
  });
}
