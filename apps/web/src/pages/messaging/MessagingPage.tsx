import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, Coins, FlaskConical, Mail, MessageCircle, MessageSquareText, RotateCcw, Save, Send, ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';
import { CHANNELS, CHANNEL_LABELS, CREDIT_COST, MESSAGE_EVENTS, MESSAGE_EVENT_KEYS, type Channel, type MessagingSettings } from '@edumin/shared';
import { apiPage, get, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useDebounced } from '@/lib/hooks';
import { fmtDateTime, money, num, titleCase } from '@/lib/format';
import { openRazorpay } from '@/lib/razorpay';
import { Badge, Button, Card, Checkbox, ErrorState, Field, Input, Loading, Modal, PageHeader, Select, Stat, StatusBadge, Tabs, clsx, confirm } from '@/components/ui';
import { DataTable, Toolbar } from '@/components/DataTable';

type Tab = 'settings' | 'log' | 'credits';

const ICON: Record<Channel, typeof Mail> = { email: Mail, whatsapp: MessageCircle, sms: MessageSquareText };

export function MessagingPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'settings';
  const q = useQuery({ queryKey: ['messaging'], queryFn: () => get<any>('/messaging') });
  const [testing, setTesting] = useState(false);
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  if (q.isLoading || !q.data) return <Loading />;
  const d = q.data;
  const simulated = d.providers.filter((p: any) => !p.live).map((p: any) => CHANNEL_LABELS[p.channel as Channel]);
  const stat = (c: Channel) => d.thisMonth.find((s: any) => s.channel === c) ?? { total: 0, delivered: 0, failed: 0 };
  return (
    <>
      <PageHeader
        title="WhatsApp, SMS & Email"
        description="Send report cards, receipts, fee reminders and alerts to parents automatically."
        actions={
          can('messaging.edit') && (
            <Button variant="secondary" icon={<FlaskConical className="size-4" />} onClick={() => setTesting(true)}>
              Send test
            </Button>
          )
        }
      />
      {simulated.length > 0 && (
        <div className="mb-5 flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          <span>
            <b>Test mode for {simulated.join(', ')}:</b> messages are recorded and marked delivered, but not actually sent. They go live automatically once the platform's provider keys are configured.
          </span>
        </div>
      )}
      {!d.featureEnabled && (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">WhatsApp and SMS aren't included in your plan. Email delivery is available. Contact support to upgrade.</div>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Message credits"
          value={num(d.credits)}
          sub={d.credits < d.settings.lowCreditAlert ? <span className="text-red-600">Running low</span> : '1 credit = 1 WhatsApp or SMS · email is free'}
          icon={<Coins className="size-5" />}
          tone={d.credits < d.settings.lowCreditAlert ? 'red' : 'brand'}
        />
        {CHANNELS.map((c) => {
          const s = stat(c);
          const Icon = ICON[c];
          return (
            <Stat
              key={c}
              label={`${CHANNEL_LABELS[c]} this month`}
              value={num(s.total)}
              sub={s.total ? `${Math.round((s.delivered / s.total) * 100)}% delivered${s.failed ? ` · ${s.failed} failed` : ''}` : d.settings.channels[c] ? 'Enabled' : 'Off'}
              icon={<Icon className="size-5" />}
              tone={c === 'whatsapp' ? 'green' : c === 'sms' ? 'violet' : 'blue'}
            />
          );
        })}
      </div>
      <Tabs
        tabs={[
          { value: 'settings', label: 'Channels & events' },
          { value: 'log', label: 'Delivery log' },
          { value: 'credits', label: 'Credits' },
        ]}
        value={tab}
        onChange={(t) => setParams({ tab: t })}
      />
      {tab === 'settings' && <Settings data={d} canEdit={can('messaging.edit')} />}
      {tab === 'log' && <Log canRetry={can('messaging.create')} />}
      {tab === 'credits' && <Credits data={d} canBuy={can('messaging.edit')} />}
      <TestModal open={testing} onClose={() => setTesting(false)} channels={d.settings.channels} />
    </>
  );
}

function Settings({ data, canEdit }: { data: any; canEdit: boolean }) {
  const [s, setS] = useState<MessagingSettings>(data.settings);
  useEffect(() => setS(data.settings), [data.settings]);
  const save = useAction(() => put('/messaging/settings', s), { success: 'Messaging settings saved', invalidate: [['messaging']] });
  const toggleEvent = (event: string, c: Channel, on: boolean) =>
    setS((p) => {
      const cur = (p.events as any)[event] ?? [];
      return { ...p, events: { ...p.events, [event]: on ? [...cur, c] : cur.filter((x: Channel) => x !== c) } };
    });
  const locked = (c: Channel) => c !== 'email' && !data.featureEnabled;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        {CHANNELS.map((c) => {
          const Icon = ICON[c];
          const prov = data.providers.find((p: any) => p.channel === c);
          const on = s.channels[c];
          return (
            <button
              key={c}
              type="button"
              disabled={!canEdit || locked(c)}
              onClick={() => setS({ ...s, channels: { ...s.channels, [c]: !on } })}
              className={clsx('card flex items-start gap-4 p-5 text-left transition', on ? 'border-brand-200 ring-1 ring-brand-200' : 'hover:border-slate-300', (locked(c) || !canEdit) && 'cursor-not-allowed opacity-60')}
            >
              <div className={clsx('grid size-10 shrink-0 place-items-center rounded-lg', on ? 'bg-brand text-white' : 'bg-slate-100 text-slate-500')}>
                <Icon className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-slate-900">{CHANNEL_LABELS[c]}</p>
                  <span className={clsx('relative h-5 w-9 shrink-0 rounded-full transition', on ? 'bg-brand' : 'bg-slate-300')}>
                    <span className={clsx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-all', on ? 'left-4.5' : 'left-0.5')} />
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {CREDIT_COST[c] ? `${CREDIT_COST[c]} credit per message` : 'Free'} · {prov?.live ? prov.provider : 'Test mode'}
                </p>
              </div>
            </button>
          );
        })}
      </div>
      <Card title="What gets sent where" subtitle="In-app notifications are always sent. Tick the extra channels for each event." padded={false} actions={canEdit && <Button icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-slate-50/70">
              <tr>
                <th className="th">Event</th>
                <th className="th">Sent to</th>
                {CHANNELS.map((c) => (
                  <th key={c} className="th text-center">
                    {CHANNEL_LABELS[c]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {MESSAGE_EVENT_KEYS.map((e) => (
                <tr key={e}>
                  <td className="td">
                    <p className="font-medium text-slate-900">{MESSAGE_EVENTS[e].label}</p>
                    <p className="text-xs text-slate-500">{MESSAGE_EVENTS[e].description}</p>
                  </td>
                  <td className="td text-slate-500">{MESSAGE_EVENTS[e].audience}</td>
                  {CHANNELS.map((c) => (
                    <td key={c} className="td text-center">
                      <input
                        type="checkbox"
                        aria-label={`${MESSAGE_EVENTS[e].label} via ${CHANNEL_LABELS[c]}`}
                        className="size-4 accent-[var(--brand)] disabled:opacity-40"
                        disabled={!canEdit || !s.channels[c]}
                        checked={!!s.events[e]?.includes(c)}
                        onChange={(ev) => toggleEvent(e, c, ev.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-3 border-t border-slate-100 px-5 py-3">
          <Field label="Warn me when credits fall below" className="w-64">
            <Input type="number" value={s.lowCreditAlert} disabled={!canEdit} onChange={(e) => setS({ ...s, lowCreditAlert: Number(e.target.value) })} />
          </Field>
        </div>
      </Card>
    </div>
  );
}

function Log({ canRetry }: { canRetry: boolean }) {
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [event, setEvent] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<any>(null);
  const q = useDebounced(search);
  const params = { search: q, channel, status, event, page, pageSize: 25 };
  const list = useQuery({ queryKey: ['message-log', params], queryFn: () => apiPage('/messaging/log', params), placeholderData: keepPreviousData, refetchInterval: 10_000 });
  const retry = useAction((id: string) => post(`/messaging/${id}/retry`), { success: 'Queued again', invalidate: [['message-log'], ['messaging']] });
  return (
    <Card padded={false}>
      <Toolbar search={search} onSearch={setSearch} placeholder="Number, email, name or text">
        <Select value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="All channels" options={CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />
        <Select value={event} onChange={(e) => setEvent(e.target.value)} placeholder="All events" options={MESSAGE_EVENT_KEYS.map((k) => ({ value: k, label: MESSAGE_EVENTS[k].label }))} />
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          placeholder="Any status"
          options={['queued', 'sent', 'delivered', 'read', 'failed'].map((s) => ({ value: s, label: titleCase(s) }))}
        />
      </Toolbar>
      <DataTable
        rows={list.data?.rows}
        loading={list.isLoading}
        rowKey={(r: any) => r.id}
        onRowClick={setOpen}
        pagination={list.data ? { page, pageSize: 25, total: list.data.meta.total, onPage: setPage } : undefined}
        columns={[
          { key: 'createdAt', header: 'When', render: (r: any) => fmtDateTime(r.createdAt) },
          {
            key: 'channel',
            header: 'Channel',
            render: (r: any) => {
              const Icon = ICON[r.channel as Channel];
              return (
                <span className="inline-flex items-center gap-1.5">
                  <Icon className="size-4 text-slate-400" /> {CHANNEL_LABELS[r.channel as Channel]}
                </span>
              );
            },
          },
          { key: 'to', header: 'To', render: (r: any) => <div><p className="font-medium text-slate-900">{r.recipientName ?? '—'}</p><p className="text-xs text-slate-500">{r.recipient}</p></div> },
          { key: 'event', header: 'Event', render: (r: any) => MESSAGE_EVENTS[r.event as keyof typeof MESSAGE_EVENTS]?.label ?? r.event, hideOnMobile: true },
          { key: 'body', header: 'Message', render: (r: any) => <span className="block max-w-80 truncate text-slate-500">{r.hasAttachment ? '📎 ' : ''}{r.body}</span>, hideOnMobile: true },
          { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status === 'skipped' ? 'failed' : r.status} label={r.status === 'read' ? 'Read' : undefined} /> },
          {
            key: 'x',
            header: '',
            align: 'right',
            render: (r: any) =>
              canRetry && ['failed', 'skipped'].includes(r.status) ? (
                <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={(e) => (e.stopPropagation(), retry.mutate(r.id))}>
                  Retry
                </Button>
              ) : null,
          },
        ]}
      />
      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.subject ?? 'Message'} description={open ? `${CHANNEL_LABELS[open.channel as Channel]} to ${open.recipientName ?? ''} (${open.recipient})` : ''}>
        {open && (
          <div className="space-y-3 text-sm">
            <p className="rounded-lg bg-slate-50 p-3 whitespace-pre-wrap text-slate-700">{open.body}</p>
            {open.hasAttachment && <p className="text-slate-500">📎 PDF attached</p>}
            <p className="text-slate-500">
              Status: <StatusBadge status={open.status === 'skipped' ? 'failed' : open.status} /> {open.deliveredAt && `· delivered ${fmtDateTime(open.deliveredAt)}`}
            </p>
            {open.error && <p className="rounded-lg bg-red-50 p-3 text-red-700">{open.error}</p>}
            <p className="text-slate-500">Credits used: {open.credits}</p>
          </div>
        )}
      </Modal>
    </Card>
  );
}

function Credits({ data, canBuy }: { data: any; canBuy: boolean }) {
  const { school, user } = useAuth();
  const ledger = useQuery({ queryKey: ['credit-ledger'], queryFn: () => get<any[]>('/messaging/credits') });
  const [buying, setBuying] = useState<string | null>(null);
  const qc = useQueryClient();
  const buy = async (pack: any) => {
    setBuying(pack.key);
    try {
      const order = await post<any>('/messaging/credits/orders', { packKey: pack.key });
      let res: any;
      if (order.gateway === 'razorpay') {
        const paid = await openRazorpay({ keyId: order.keyId, orderId: order.razorpayOrderId, amount: order.amount, name: 'Edumin', description: `${num(pack.credits)} message credits`, color: school?.branding.primaryColor, prefill: { name: user?.fullName, email: user?.email ?? undefined } });
        res = await post(`/messaging/credits/orders/${order.orderId}/verify`, paid);
      } else {
        if (!(await confirm({ title: `Buy ${num(pack.credits)} credits for ${money(pack.price)}?`, message: 'Test mode: no money is charged. In production this opens Razorpay checkout.', confirmLabel: 'Simulate payment' }))) return;
        res = await post(`/messaging/credits/orders/${order.orderId}/mock-pay`);
      }
      toast.success(`${num(res.credits)} credits added`);
      ledger.refetch();
      qc.invalidateQueries({ queryKey: ['messaging'] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBuying(null);
    }
  };
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        {data.packs.map((p: any, i: number) => (
          <div key={p.key} className={clsx('card flex flex-col p-6', i === 1 && 'border-brand-200 ring-1 ring-brand-200')}>
            <div className="flex items-center justify-between">
              <p className="font-semibold text-slate-900">{p.label}</p>
              {i === 1 && <Badge tone="brand">Popular</Badge>}
            </div>
            <p className="mt-3 text-3xl font-semibold tracking-tight">{num(p.credits)}</p>
            <p className="text-sm text-slate-500">credits</p>
            <p className="mt-4 text-lg font-semibold">{money(p.price, { compact: false })}</p>
            <p className="text-xs text-slate-500">₹{(p.price / p.credits).toFixed(2)} per message · incl. GST</p>
            {canBuy && (
              <Button className="mt-5" variant={i === 1 ? 'primary' : 'secondary'} icon={<ShoppingCart className="size-4" />} loading={buying === p.key} onClick={() => buy(p)}>
                Buy now
              </Button>
            )}
          </div>
        ))}
      </div>
      <Card title="Credit history" padded={false}>
        <DataTable
          rows={ledger.data}
          loading={ledger.isLoading}
          rowKey={(r: any) => r.id}
          dense
          columns={[
            { key: 'createdAt', header: 'When', render: (r: any) => fmtDateTime(r.createdAt) },
            { key: 'kind', header: 'Type', render: (r: any) => <Badge tone={r.delta > 0 ? 'green' : 'gray'}>{titleCase(r.kind)}</Badge> },
            { key: 'note', header: 'Details' },
            { key: 'delta', header: 'Credits', align: 'right', render: (r: any) => <span className={clsx('font-medium tabular-nums', r.delta > 0 ? 'text-emerald-600' : 'text-slate-700')}>{r.delta > 0 ? '+' : ''}{num(r.delta)}</span> },
            { key: 'balanceAfter', header: 'Balance', align: 'right', render: (r: any) => num(r.balanceAfter) },
          ]}
        />
      </Card>
    </div>
  );
}

function TestModal({ open, onClose, channels }: { open: boolean; onClose: () => void; channels: Record<Channel, boolean> }) {
  const enabled = CHANNELS.filter((c) => channels[c]);
  const [channel, setChannel] = useState<Channel>(enabled[0] ?? 'email');
  const [to, setTo] = useState('');
  const send = useAction(() => post('/messaging/test', { channel, to }), { success: 'Test message queued — check the delivery log', invalidate: [['message-log'], ['messaging']], onSuccess: onClose });
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Send a test message"
      footer={
        <Button icon={<Send className="size-4" />} loading={send.isPending} disabled={!to} onClick={() => send.mutate()}>
          Send
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Channel">
          <Select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} options={enabled.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))} />
        </Field>
        <Field label={channel === 'email' ? 'Email address' : 'Mobile number'} hint={channel !== 'email' ? 'Uses 1 credit' : undefined}>
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder={channel === 'email' ? 'you@school.edu' : '98765 43210'} />
        </Field>
        <p className="flex items-center gap-1.5 text-xs text-slate-500">
          <CheckCheck className="size-3.5" /> Uses the approved “announcement” template.
        </p>
      </div>
    </Modal>
  );
}
