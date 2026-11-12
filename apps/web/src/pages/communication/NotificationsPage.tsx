import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { disablePush, enablePush, pushState, type PushState } from '@/lib/pwa';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellRing, CheckCheck } from 'lucide-react';
import { post } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Button, Card, EmptyState, Loading, PageHeader, Tabs, clsx } from '@/components/ui';

function PushCard() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pushState().then(setState).catch(() => setState('unsupported'));
  }, []);
  if (!state || state === 'unsupported') return null;
  const toggle = async () => {
    setBusy(true);
    try {
      if (state === 'on') {
        await disablePush();
        setState('off');
      } else {
        await enablePush();
        setState('on');
        toast.success('Notifications enabled on this device');
      }
    } catch (e) {
      toast.error((e as Error).message);
      setState(await pushState().catch(() => 'off' as PushState));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card mb-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <BellRing className="size-5 shrink-0 text-brand" />
      <div className="flex-1">
        <p className="text-sm font-medium text-slate-900">Notifications on this device</p>
        <p className="text-xs text-slate-500">
          {state === 'on'
            ? "You'll get alerts even when the app is closed."
            : state === 'denied'
              ? 'Blocked in your browser settings — allow notifications for this site to turn them on.'
              : state === 'unavailable'
                ? 'Install the app (profile menu → Install app) to get notifications on this device.'
                : 'Get absence alerts, fee reminders and results instantly.'}
        </p>
      </div>
      {(state === 'on' || state === 'off') && (
        <Button size="sm" variant={state === 'on' ? 'secondary' : 'primary'} loading={busy} onClick={toggle}>
          {state === 'on' ? 'Turn off' : 'Turn on'}
        </Button>
      )}
    </div>
  );
}

export function NotificationsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const q = useQuery({
    queryKey: ['notifications', 'page', tab],
    queryFn: async () => {
      const res = await fetch(`/api/notifications?limit=100${tab === 'unread' ? '&unread=true' : ''}`, { credentials: 'include' });
      const j = await res.json();
      return { rows: j.data as any[], unread: j.unreadCount as number };
    },
  });
  const markAll = async () => {
    await post('/notifications/read', {});
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return (
    <>
      <PageHeader
        title="Notifications"
        actions={
          !!q.data?.unread && (
            <Button variant="secondary" icon={<CheckCheck className="size-4" />} onClick={markAll}>
              Mark all as read
            </Button>
          )
        }
      />
      <PushCard />
      <Tabs
        tabs={[
          { value: 'all', label: 'All' },
          { value: 'unread', label: 'Unread', count: q.data?.unread },
        ]}
        value={tab}
        onChange={setTab}
      />
      <Card padded={false}>
        {q.isLoading ? (
          <Loading />
        ) : q.data?.rows.length ? (
          <ul className="divide-y divide-slate-100">
            {q.data.rows.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="flex w-full gap-3 px-5 py-3.5 text-left hover:bg-slate-50"
                  onClick={async () => {
                    if (!n.readAt) await post('/notifications/read', { ids: [n.id] });
                    qc.invalidateQueries({ queryKey: ['notifications'] });
                    if (n.link) navigate(n.link);
                  }}
                >
                  <span className={clsx('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-slate-200' : 'bg-brand')} />
                  <span className="min-w-0 flex-1">
                    <span className={clsx('block text-sm', n.readAt ? 'text-slate-700' : 'font-semibold text-slate-900')}>{n.title}</span>
                    {n.body && <span className="block text-sm text-slate-500">{n.body}</span>}
                    <span className="mt-0.5 block text-xs text-slate-400">{fmtDateTime(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<Bell className="size-5" />} title="No notifications" />
        )}
      </Card>
    </>
  );
}
