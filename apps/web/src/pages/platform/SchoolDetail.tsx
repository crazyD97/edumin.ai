import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Coins, ExternalLink, KeyRound, Pause, Play, Receipt } from 'lucide-react';
import { ALL_FEATURES, FEATURES } from '@edumin/shared';
import { get, patch, post } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { schoolUrl } from '@/lib/tenant';
import { ago, fmtDate, fmtDateTime, money, num, titleCase } from '@/lib/format';
import { Badge, Button, Card, ErrorState, Field, Input, KV, Loading, PageHeader, Select, Stat, StatusBadge, Textarea, clsx, confirm } from '@/components/ui';
import { FormModal } from '@/components/FormModal';

export function SchoolDetailPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['platform-school', id], queryFn: () => get<any>(`/platform/schools/${id}`) });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => get<any[]>('/platform/plans') });
  const [sub, setSub] = useState<any>(null);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [paying, setPaying] = useState(false);
  const [granting, setGranting] = useState(false);
  const [resetFor, setResetFor] = useState<any>(null);
  useEffect(() => {
    if (q.data) {
      setOverrides(q.data.featureOverrides ?? {});
      setSub({ planId: q.data.planId ?? '', trialEndsAt: q.data.trialEndsAt?.slice(0, 10) ?? '', subscriptionStatus: q.data.subscriptionStatus, subscriptionEndsAt: q.data.subscriptionEndsAt?.slice(0, 10) ?? '', notes: q.data.notes ?? '' });
    }
  }, [q.data]);
  const update = useAction((body: any) => patch(`/platform/schools/${id}`, body), { success: 'School updated', invalidate: [['platform-school'], ['platform-schools'], ['platform-stats']] });
  if (q.isLoading || !sub) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const s = q.data;
  const planFeatures = new Set<string>(s.plan?.features ?? ALL_FEATURES);
  const effective = (f: string) => (f in overrides ? overrides[f] : planFeatures.has(f));

  return (
    <>
      <PageHeader
        back={{ to: '/platform/schools', label: 'Schools' }}
        title={
          <span className="flex items-center gap-3">
            {s.name} <StatusBadge status={s.status} />
          </span>
        }
        description={`${s.slug} · joined ${fmtDate(s.createdAt)}`}
        actions={
          <>
            <a href={schoolUrl(s.slug) + '/login'} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <ExternalLink className="size-4" /> Login page
            </a>
            {s.status === 'suspended' ? (
              <Button icon={<Play className="size-4" />} onClick={() => update.mutate({ status: 'active' })}>
                Reactivate
              </Button>
            ) : (
              <Button variant="danger" icon={<Pause className="size-4" />} onClick={async () => (await confirm({ title: `Suspend ${s.name}?`, message: 'All users of this school are blocked until it is reactivated. Data is kept.', danger: true, confirmLabel: 'Suspend' })) && update.mutate({ status: 'suspended' })}>
                Suspend
              </Button>
            )}
            {s.status === 'trial' && <Button onClick={() => update.mutate({ status: 'active', subscriptionStatus: 'active' })}>Convert to paid</Button>}
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Active students" value={num(s.usage.activeStudents)} sub={s.plan?.maxStudents ? `Plan limit ${num(s.plan.maxStudents)}` : 'Unlimited'} tone={s.plan?.maxStudents && s.usage.activeStudents > s.plan.maxStudents ? 'red' : 'brand'} />
        <Stat label="Staff accounts" value={num(s.usage.staff)} sub={s.plan?.maxStaff ? `Plan limit ${num(s.plan.maxStaff)}` : 'Unlimited'} tone="violet" />
        <Stat label="Storage used" value={`${(s.usage.storageBytes / 1024 / 1024).toFixed(1)} MB`} tone="blue" />
        <Stat label="Fees processed" value={money(s.usage.feesCollected, { compact: true })} tone="green" />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Subscription" actions={<Button size="sm" loading={update.isPending} onClick={() => update.mutate({ planId: sub.planId || null, trialEndsAt: sub.trialEndsAt || null, subscriptionStatus: sub.subscriptionStatus, subscriptionEndsAt: sub.subscriptionEndsAt || null, notes: sub.notes })}>Save</Button>}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Plan">
                <Select value={sub.planId} onChange={(e) => setSub({ ...sub, planId: e.target.value })} placeholder="No plan (all features)" options={(plans.data ?? []).map((p) => ({ value: p.id, label: `${p.name} · ${money(p.priceMonthly)}/mo` }))} />
              </Field>
              <Field label="Subscription status">
                <Select value={sub.subscriptionStatus} onChange={(e) => setSub({ ...sub, subscriptionStatus: e.target.value })} options={['trialing', 'active', 'past_due', 'cancelled'].map((v) => ({ value: v, label: titleCase(v) }))} />
              </Field>
              <Field label="Trial ends" hint={s.status === 'trial' && s.trialEndsAt ? `Ends ${ago(s.trialEndsAt)}` : undefined}>
                <Input type="date" value={sub.trialEndsAt} onChange={(e) => setSub({ ...sub, trialEndsAt: e.target.value })} />
              </Field>
              <Field label="Paid until">
                <Input type="date" value={sub.subscriptionEndsAt} onChange={(e) => setSub({ ...sub, subscriptionEndsAt: e.target.value })} />
              </Field>
              <Field label="Internal notes" className="sm:col-span-2">
                <Textarea value={sub.notes} onChange={(e) => setSub({ ...sub, notes: e.target.value })} />
              </Field>
            </div>
          </Card>
          <Card title="Feature access" subtitle="Defaults come from the plan; toggle to override for this school." actions={<Button size="sm" loading={update.isPending} onClick={() => update.mutate({ featureOverrides: overrides })}>Save</Button>}>
            <div className="grid gap-2 sm:grid-cols-2">
              {ALL_FEATURES.map((f) => {
                const on = effective(f);
                const overridden = f in overrides;
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setOverrides((o) => (planFeatures.has(f) === !on ? (({ [f]: _, ...rest }) => rest)(o) : { ...o, [f]: !on }))}
                    className={clsx('flex items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition', on ? 'border-brand-200 bg-brand-50' : 'border-slate-200 bg-white')}
                  >
                    <span className={on ? 'font-medium text-slate-900' : 'text-slate-500'}>{FEATURES[f]}</span>
                    <span className="flex items-center gap-2">
                      {overridden && <Badge tone="amber">Override</Badge>}
                      <span className={clsx('relative h-5 w-9 rounded-full transition', on ? 'bg-brand' : 'bg-slate-300')}>
                        <span className={clsx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-all', on ? 'left-4.5' : 'left-0.5')} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>
          <Card title="Subscription history" padded={false} actions={<Button size="sm" variant="secondary" icon={<Receipt className="size-4" />} onClick={() => setPaying(true)}>Record payment</Button>}>
            <ul className="divide-y divide-slate-100">
              {s.history.map((h: any) => (
                <li key={h.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <span>
                    <span className="font-medium text-slate-800">{titleCase(h.type)}</span>
                    {h.note && <span className="text-slate-500"> — {h.note}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {h.amount ? `${money(h.amount)} · ` : ''}
                    {fmtDateTime(h.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Message credits" subtitle="WhatsApp & SMS wallet" actions={<Button size="sm" variant="secondary" icon={<Coins className="size-4" />} onClick={() => setGranting(true)}>Add / deduct</Button>} padded={false}>
            <p className="px-5 pt-4 text-3xl font-semibold tabular-nums">{num(s.credits)}</p>
            <ul className="mt-3 max-h-64 divide-y divide-slate-100 overflow-y-auto border-t border-slate-100">
              {s.creditLedger.map((t: any) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-5 py-2 text-xs">
                  <span className="min-w-0 truncate text-slate-600">{t.note ?? titleCase(t.kind)}</span>
                  <span className={clsx('shrink-0 font-medium tabular-nums', t.delta > 0 ? 'text-emerald-600' : 'text-slate-700')}>{t.delta > 0 ? '+' : ''}{num(t.delta)}</span>
                </li>
              ))}
              {!s.creditLedger.length && <li className="px-5 py-4 text-xs text-slate-400">No credit activity yet</li>}
            </ul>
          </Card>
          <Card title="School admins" padded={false}>
            <ul className="divide-y divide-slate-100">
              {s.admins.map((a: any) => (
                <li key={a.id} className="px-5 py-3">
                  <p className="text-sm font-medium text-slate-900">{a.fullName}</p>
                  <p className="text-xs text-slate-500">
                    {a.email} · last sign-in {a.lastLoginAt ? ago(a.lastLoginAt) : 'never'}
                  </p>
                  <button className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline" onClick={() => setResetFor(a)}>
                    <KeyRound className="size-3.5" /> Reset password
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Branding">
            <KV
              cols={2}
              items={[
                ['Primary', <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded" style={{ background: s.branding.primaryColor }} />{s.branding.primaryColor}</span>],
                ['Email', s.branding.email],
                ['Phone', s.branding.phone],
                ['Website', s.branding.website],
              ]}
            />
          </Card>
        </div>
      </div>
      <FormModal
        open={granting}
        onClose={() => setGranting(false)}
        title="Add or deduct message credits"
        description="Use after an offline payment (bank transfer, cheque) or as goodwill. Negative numbers deduct."
        fields={[
          { name: 'credits', label: 'Credits', type: 'number', required: true, span: 1, hint: 'e.g. 5000 or -200' },
          { name: 'amountPaid', label: 'Amount received (₹)', type: 'number', span: 1, hint: 'Leave blank for a free grant' },
          { name: 'note', label: 'Note', placeholder: 'NEFT ref, reason…' },
        ]}
        submit={(v) => post(`/platform/schools/${id}/credits`, { credits: Number(v.credits), amountPaid: v.amountPaid ? Number(v.amountPaid) : null, note: v.note || null })}
        success="Credits updated"
        invalidate={[['platform-school']]}
      />
      <FormModal
        open={paying}
        onClose={() => setPaying(false)}
        title="Record subscription payment"
        description="Manual billing for now — automated payments can write to the same ledger later."
        initial={{ extendMonths: 12 }}
        fields={[
          { name: 'amount', label: 'Amount', type: 'number', required: true, span: 1 },
          { name: 'extendMonths', label: 'Extend subscription by (months)', type: 'number', span: 1 },
          { name: 'note', label: 'Note', placeholder: 'Invoice #, bank reference…' },
        ]}
        submit={(v) => post(`/platform/schools/${id}/payments`, { amount: Number(v.amount), extendMonths: Number(v.extendMonths || 0), note: v.note })}
        success="Payment recorded"
        invalidate={[['platform-school']]}
      />
      <FormModal
        open={!!resetFor}
        onClose={() => setResetFor(null)}
        title={`Reset password · ${resetFor?.fullName ?? ''}`}
        fields={[{ name: 'password', label: 'New password', required: true, hint: 'At least 8 characters. Existing sessions are signed out.' }]}
        submit={(v) => post(`/platform/schools/${id}/reset-admin-password`, { userId: resetFor.id, password: v.password })}
        success="Password reset"
      />
    </>
  );
}
