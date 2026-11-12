import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { openRazorpay } from '@/lib/razorpay';
import { BadgePercent, CreditCard, Receipt, Wallet } from 'lucide-react';
import { PAYMENT_METHODS } from '@edumin/shared';
import { download, get, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime, money, titleCase, today } from '@/lib/format';
import { Button, Card, ErrorState, Field, Input, Loading, Modal, PageHeader, Select, Stat, StatusBadge, Textarea, clsx } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { FormModal } from '@/components/FormModal';

export function StudentFeesPage() {
  const { id } = useParams();
  const { can, user, hasFeature, school } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['ledger', id], queryFn: () => get<any>(`/fees/students/${id}/ledger`) });
  const heads = useQuery({ queryKey: ['fee-heads'], queryFn: () => get<any[]>('/fees/heads'), enabled: can('fees.approve') });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState(false);
  const [concession, setConcession] = useState(false);
  const [adjusting, setAdjusting] = useState<any>(null);
  const staff = user?.role.scope !== 'own';
  const online = useAction(() => post<any>('/fees/online/initiate', { studentId: id, amount: selectedBalance || q.data.summary.balance, invoiceIds: [...selected] }), {
    onSuccess: async (r: any) => {
      if (r.gateway !== 'razorpay') return navigate(r.checkoutUrl);
      try {
        const paid = await openRazorpay({ keyId: r.keyId, orderId: r.razorpayOrderId, amount: r.amount, name: school?.name ?? 'School fees', description: `Fees · ${q.data.student.name}`, color: school?.branding.primaryColor, prefill: { name: user?.fullName, email: user?.email ?? undefined } });
        const done = await post<any>(`/fees/online/${r.paymentId}/verify`, paid);
        toast.success(`Payment successful · ${done.receiptNo}`);
        setSelected(new Set());
        qc.invalidateQueries({ queryKey: ['ledger'] });
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
  });
  const cancel = useAction((invId: string) => post(`/fees/invoices/${invId}/cancel`), { success: 'Invoice cancelled', invalidate: [['ledger']] });
  const open = useMemo(() => q.data?.invoices.filter((i: any) => ['unpaid', 'partial'].includes(i.status)) ?? [], [q.data]);
  const selectedBalance = open.filter((i: any) => selected.has(i.id)).reduce((a: number, i: any) => a + i.balance, 0);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const { student, summary, invoices, payments } = q.data;
  const toggle = (invId: string) => setSelected((s) => (s.has(invId) ? (s.delete(invId), new Set(s)) : new Set(s.add(invId))));

  return (
    <>
      <PageHeader
        back={staff ? { to: '/fees', label: 'Fees' } : undefined}
        title={student.name}
        description={`${student.admissionNo} · fee ledger for the current academic year`}
        actions={
          <>
            {staff && can('fees.approve') && (
              <Button variant="secondary" icon={<BadgePercent className="size-4" />} onClick={() => setConcession(true)}>
                Add concession
              </Button>
            )}
            {staff && can('fees.create') && summary.balance > 0 && (
              <Button icon={<Wallet className="size-4" />} onClick={() => setPaying(true)}>
                Record payment{selected.size ? ` (${selected.size})` : ''}
              </Button>
            )}
            {!staff && hasFeature('online_payments') && summary.balance > 0 && (
              <Button icon={<CreditCard className="size-4" />} loading={online.isPending} onClick={() => online.mutate()}>
                Pay {money(selectedBalance || summary.balance)} online
              </Button>
            )}
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Total fees" value={money(summary.gross)} />
        <Stat label="Concessions" value={money(summary.concessions)} tone="violet" />
        <Stat label="Paid" value={money(summary.paid)} tone="green" />
        <Stat label="Balance" value={money(summary.balance)} tone="amber" />
        <Stat label="Overdue" value={money(summary.overdue)} tone="red" sub={summary.lateFees ? `incl. ${money(summary.lateFees)} late fees` : undefined} />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Invoices" subtitle={open.length ? 'Select invoices to pay specific dues; otherwise the oldest are settled first.' : undefined} padded={false} className="xl:col-span-2">
          <DataTable
            rows={invoices}
            rowKey={(r: any) => r.id}
            dense
            columns={[
              {
                key: 'sel',
                header: '',
                render: (r: any) =>
                  ['unpaid', 'partial'].includes(r.status) ? <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="size-4 accent-[var(--brand)]" aria-label={`Select ${r.title}`} /> : null,
              },
              { key: 'title', header: 'Invoice', render: (r: any) => <span className="font-medium text-slate-800">{r.title}</span> },
              { key: 'dueDate', header: 'Due', render: (r: any) => <span className={clsx(r.balance > 0 && r.dueDate < today() && 'font-medium text-red-600')}>{fmtDate(r.dueDate)}</span> },
              { key: 'amount', header: 'Amount', align: 'right', render: (r: any) => money(r.amount), hideOnMobile: true },
              { key: 'conc', header: 'Concession', align: 'right', render: (r: any) => (r.discount + r.scholarship ? `−${money(r.discount + r.scholarship)}` : '—'), hideOnMobile: true },
              { key: 'lateFee', header: 'Late fee', align: 'right', render: (r: any) => (r.lateFee ? money(r.lateFee) : '—'), hideOnMobile: true },
              { key: 'balance', header: 'Balance', align: 'right', render: (r: any) => <b className="tabular-nums">{money(r.balance)}</b> },
              { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
              {
                key: 'x',
                header: '',
                align: 'right',
                render: (r: any) =>
                  staff &&
                  ['unpaid', 'partial'].includes(r.status) && (
                    <div className="flex justify-end gap-1">
                      {can('fees.approve') && (
                        <Button size="sm" variant="ghost" onClick={() => setAdjusting(r)}>
                          Adjust
                        </Button>
                      )}
                      {can('fees.delete') && r.paid === 0 && (
                        <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>
                          Cancel
                        </Button>
                      )}
                    </div>
                  ),
              },
            ]}
          />
        </Card>
        <Card title="Payment history" padded={false}>
          {payments.length ? (
            <ul className="divide-y divide-slate-100">
              {payments.map((p: any) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">
                      {money(p.amount)} <span className="font-normal text-slate-500">· {titleCase(p.method)}</span>
                    </p>
                    <p className="text-xs text-slate-500">
                      {p.receiptNo} · {fmtDateTime(p.paidAt)}
                    </p>
                  </div>
                  {p.status === 'completed' ? (
                    <Button size="sm" variant="ghost" icon={<Receipt className="size-4" />} onClick={() => download('GET', `/fees/payments/${p.id}/receipt`)}>
                      PDF
                    </Button>
                  ) : (
                    <StatusBadge status={p.status} />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-8 text-center text-sm text-slate-500">No payments yet</p>
          )}
        </Card>
      </div>
      <PaymentModal open={paying} onClose={() => setPaying(false)} studentId={student.id} max={selected.size ? selectedBalance : summary.balance} invoiceIds={[...selected]} onDone={() => setSelected(new Set())} />
      <FormModal
        open={concession}
        onClose={() => setConcession(false)}
        title="Add concession"
        description="Applies to this year's unpaid invoices immediately and to invoices generated later."
        initial={{ kind: 'discount', valueType: 'percent' }}
        fields={[
          {
            name: 'kind',
            label: 'Type',
            type: 'select',
            required: true,
            span: 1,
            options: [
              { value: 'discount', label: 'Discount' },
              { value: 'scholarship', label: 'Scholarship' },
            ],
          },
          { name: 'feeHeadId', label: 'Fee head', type: 'select', options: (heads.data ?? []).map((h) => ({ value: h.id, label: h.name })), placeholder: 'All fees', span: 1 },
          {
            name: 'valueType',
            label: 'Value type',
            type: 'select',
            required: true,
            span: 1,
            options: [
              { value: 'percent', label: 'Percentage' },
              { value: 'fixed', label: 'Fixed amount per invoice' },
            ],
          },
          { name: 'value', label: 'Value', type: 'number', required: true, span: 1 },
          { name: 'reason', label: 'Reason', type: 'textarea' },
        ]}
        submit={(v) => post('/fees/concessions', { ...v, studentId: student.id, value: Number(v.value), feeHeadId: v.feeHeadId || null })}
        success="Concession added"
        invalidate={[['ledger'], ['concessions']]}
      />
      <FormModal
        open={!!adjusting}
        onClose={() => setAdjusting(null)}
        title={`Adjust ${adjusting?.title ?? ''}`}
        initial={adjusting ? { amount: adjusting.amount, discount: adjusting.discount, lateFee: adjusting.lateFee } : {}}
        fields={[
          { name: 'amount', label: 'Amount', type: 'number', span: 1 },
          { name: 'discount', label: 'Discount', type: 'number', span: 1 },
          { name: 'lateFee', label: 'Late fee', type: 'number', span: 1, hint: 'Set to 0 to waive' },
        ]}
        submit={(v) => patch(`/fees/invoices/${adjusting.id}`, { amount: Number(v.amount), discount: Number(v.discount), lateFee: Number(v.lateFee) })}
        success="Invoice adjusted"
        invalidate={[['ledger']]}
      />
    </>
  );
}

function PaymentModal({ open, onClose, studentId, max, invoiceIds, onDone }: { open: boolean; onClose: () => void; studentId: string; max: number; invoiceIds: string[]; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(today());
  const [notes, setNotes] = useState('');
  const save = useAction(
    () => post<any>('/fees/payments', { studentId, amount: Number(amount || max), method, reference, paidAt, notes, invoiceIds: invoiceIds.length ? invoiceIds : undefined }),
    {
      success: (r: any) => `Payment recorded · ${r.receiptNo}`,
      invalidate: [['ledger'], ['invoices'], ['payments'], ['dashboard']],
      onSuccess: (r: any) => {
        download('GET', `/fees/payments/${r.id}/receipt`);
        setAmount('');
        setReference('');
        setNotes('');
        onDone();
        onClose();
      },
    },
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record payment"
      description={invoiceIds.length ? `Against ${invoiceIds.length} selected invoice(s)` : 'Settles the oldest dues first.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save & print receipt
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount" hint={`Outstanding: ${money(max)} · partial payments allowed`} className="sm:col-span-2">
          <Input type="number" min={1} max={max} step="0.01" value={amount} placeholder={String(max)} onChange={(e) => setAmount(e.target.value)} className="text-lg font-semibold" />
        </Field>
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value)} options={PAYMENT_METHODS.filter((m) => m !== 'online').map((m) => ({ value: m, label: titleCase(m) }))} />
        </Field>
        <Field label="Date">
          <Input type="date" value={paidAt} max={today()} onChange={(e) => setPaidAt(e.target.value)} />
        </Field>
        <Field label="Reference" hint="Cheque / transaction no." className="sm:col-span-2">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
