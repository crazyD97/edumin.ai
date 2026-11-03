/**
 * Mock payment gateway checkout. With a live gateway the payer is redirected
 * to the provider instead, and its webhook confirms the payment.
 */
import { useNavigate, useParams } from 'react-router';
import { useState } from 'react';
import { CreditCard, ShieldCheck } from 'lucide-react';
import { post } from '@/lib/api';
import { Button, Card, PageHeader } from '@/components/ui';
import { toast } from 'sonner';

export function CheckoutPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const finish = async (success: boolean) => {
    setBusy(true);
    try {
      const p = await post<any>(`/fees/online/${id}/mock-complete`, { success });
      toast[success ? 'success' : 'error'](success ? `Payment successful · ${p.receiptNo}` : 'Payment failed');
      navigate(`/fees/students/${p.studentId}`, { replace: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title="Secure checkout" description="Test-mode payment gateway" />
      <Card className="mx-auto max-w-md">
        <div className="text-center">
          <div className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-brand-50 text-brand">
            <CreditCard className="size-6" />
          </div>
          <p className="text-sm text-slate-600">This is the built-in test gateway. Choose an outcome to simulate the payer completing checkout.</p>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button variant="secondary" disabled={busy} onClick={() => finish(false)}>
              Simulate failure
            </Button>
            <Button loading={busy} onClick={() => finish(true)}>
              Pay now
            </Button>
          </div>
          <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-slate-400">
            <ShieldCheck className="size-3.5" /> Swap in Razorpay or Stripe via the PaymentGateway interface
          </p>
        </div>
      </Card>
    </>
  );
}
