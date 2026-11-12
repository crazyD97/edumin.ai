/** Login-free fee payment, opened from the link in WhatsApp/SMS fee reminders. */
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Lock } from 'lucide-react';
import { ApiError, api, get } from '@/lib/api';
import { applyBranding } from '@/lib/branding';
import { fmtDate, money } from '@/lib/format';
import { openRazorpay } from '@/lib/razorpay';
import { Button, ErrorState, Loading, Modal, clsx } from '@/components/ui';

export function PayPage() {
  const { studentId } = useParams();
  const [params] = useSearchParams();
  const link = { exp: params.get('exp') ?? '', sig: params.get('sig') ?? '' };
  const q = useQuery({ queryKey: ['pay', studentId], queryFn: () => get<any>(`/public/pay/${studentId}`, link), retry: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ receiptNo: string; amount: number } | null>(null);
  const [mock, setMock] = useState<{ paymentId: string; amount: number } | null>(null);

  useEffect(() => {
    if (q.data) {
      setSelected(new Set(q.data.invoices.map((i: any) => i.id)));
      applyBranding({ name: q.data.school.name, branding: { primaryColor: q.data.school.primaryColor, logoUrl: q.data.school.logoUrl } });
    }
  }, [q.data]);
  const total = useMemo(() => (q.data?.invoices ?? []).filter((i: any) => selected.has(i.id)).reduce((a: number, i: any) => a + i.balance, 0), [q.data, selected]);

  if (q.isLoading) return <Loading className="h-screen" />;
  if (q.error) return <div className="grid min-h-screen place-items-center p-6"><ErrorState error={q.error} /></div>;
  const d = q.data;
  const qs = `?exp=${link.exp}&sig=${encodeURIComponent(link.sig)}`;

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const order = await api<any>('POST', `/public/pay/${studentId}/order${qs}`, { invoiceIds: [...selected] });
      if (order.gateway === 'razorpay') {
        const r = await openRazorpay({ keyId: order.keyId, orderId: order.razorpayOrderId, amount: order.amount, name: d.school.name, description: `Fees · ${d.student.name}`, color: d.school.primaryColor });
        setDone(await api('POST', `/public/pay/${studentId}/verify${qs}`, { paymentId: order.paymentId, ...r }));
      } else setMock({ paymentId: order.paymentId, amount: order.amount });
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Payment failed');
    } finally {
      setBusy(false);
    }
  };
  const completeMock = async (success: boolean) => {
    const r = await api<any>('POST', `/public/pay/${studentId}/mock-complete${qs}`, { paymentId: mock!.paymentId, success });
    setMock(null);
    if (r.status === 'completed') setDone(r);
    else setError('Payment failed. You have not been charged.');
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-md">
        <div className="mb-6 flex items-center gap-3">
          {d.school.logoUrl ? <img src={d.school.logoUrl} alt="" className="size-11 object-contain" /> : <span className="grid size-11 place-items-center rounded-xl bg-brand font-bold text-white">{d.school.name[0]}</span>}
          <div>
            <p className="font-semibold text-slate-900">{d.school.name}</p>
            <p className="text-xs text-slate-500">Fee payment</p>
          </div>
        </div>
        {done ? (
          <div className="card p-8 text-center">
            <CheckCircle2 className="mx-auto mb-3 size-12 text-emerald-500" />
            <h1 className="text-xl font-semibold">Payment successful</h1>
            <p className="mt-2 text-sm text-slate-600">
              {money(done.amount)} received for {d.student.name}. Receipt no. <b>{done.receiptNo}</b> — a copy will be sent to you.
            </p>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="border-b border-slate-100 p-5">
              <p className="text-lg font-semibold text-slate-900">{d.student.name}</p>
              <p className="text-sm text-slate-500">
                {d.student.admissionNo}
                {d.student.classLabel ? ` · ${d.student.classLabel}` : ''}
              </p>
            </div>
            {d.invoices.length ? (
              <>
                <ul className="divide-y divide-slate-100">
                  {d.invoices.map((i: any) => (
                    <li key={i.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-5 py-3">
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--brand)]"
                          checked={selected.has(i.id)}
                          onChange={(e) => setSelected((s) => (e.target.checked ? new Set(s).add(i.id) : new Set([...s].filter((x) => x !== i.id))))}
                        />
                        <span className="flex-1">
                          <span className="block text-sm font-medium text-slate-800">{i.title}</span>
                          <span className={clsx('block text-xs', i.dueDate < new Date().toISOString().slice(0, 10) ? 'text-red-600' : 'text-slate-500')}>Due {fmtDate(i.dueDate)}</span>
                        </span>
                        <span className="text-sm font-semibold tabular-nums">{money(i.balance)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="border-t border-slate-100 bg-slate-50 p-5">
                  <div className="mb-4 flex justify-between text-base font-semibold">
                    <span>Total</span>
                    <span className="tabular-nums">{money(total)}</span>
                  </div>
                  {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
                  {d.gateway ? (
                    <Button className="h-11 w-full text-base" disabled={!selected.size} loading={busy} onClick={pay}>
                      Pay {money(total)}
                    </Button>
                  ) : (
                    <p className="text-center text-sm text-slate-600">Online payment isn't available yet. Please pay at the school office{d.school.phone ? ` or call ${d.school.phone}` : ''}.</p>
                  )}
                  <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-slate-400">
                    <Lock className="size-3" /> Secured by Razorpay · UPI, cards, net banking
                  </p>
                </div>
              </>
            ) : (
              <p className="p-8 text-center text-sm text-slate-600">No dues — all fees are paid. Thank you!</p>
            )}
          </div>
        )}
      </div>
      <Modal
        open={!!mock}
        onClose={() => setMock(null)}
        size="sm"
        title="Test checkout"
        description="This school is in test mode — no money is charged."
        footer={
          <>
            <Button variant="secondary" onClick={() => completeMock(false)}>
              Simulate failure
            </Button>
            <Button onClick={() => completeMock(true)}>Pay {mock ? money(mock.amount) : ''}</Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">In production this opens Razorpay so the parent can pay by UPI, card or net banking.</p>
      </Modal>
    </div>
  );
}
