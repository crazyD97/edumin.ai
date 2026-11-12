import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, CreditCard, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { get, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { Badge, Button, Card, Checkbox, Field, Input, Loading, LinkButton } from '@/components/ui';

export function IntegrationsTab() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => get<any[]>('/integrations') });
  const rz = q.data?.find((i) => i.provider === 'razorpay');
  const [f, setF] = useState({ enabled: false, keyId: '', keySecret: '', webhookSecret: '' });
  useEffect(() => {
    if (rz) setF({ enabled: rz.enabled, keyId: rz.keyId ?? '', keySecret: '', webhookSecret: '' });
  }, [rz]);
  const editable = can('settings.edit');
  const save = useAction(() => put('/integrations/razorpay', { enabled: f.enabled, keyId: f.keyId, keySecret: f.keySecret || undefined, webhookSecret: f.webhookSecret || undefined }), {
    success: 'Razorpay settings saved',
    invalidate: [['integrations']],
  });
  const verify = useAction(() => post('/integrations/razorpay/verify'), { success: 'Razorpay accepted your keys' });
  if (q.isLoading || !rz) return <Loading />;
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
      <Card
        title={
          <span className="flex items-center gap-2">
            <CreditCard className="size-4" /> Razorpay — online fee collection {rz.mode && <Badge tone={rz.mode === 'live' ? 'green' : 'amber'}>{rz.mode === 'live' ? 'Live' : 'Test mode'}</Badge>}
          </span>
        }
        subtitle="Parents pay by UPI, cards or net banking. Money settles directly into your school's bank account."
      >
        {!rz.featureEnabled && <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Online payments aren't included in your plan. Contact support to upgrade.</p>}
        <div className="space-y-4">
          <Checkbox checked={f.enabled} disabled={!editable || !rz.featureEnabled} onChange={(v) => setF({ ...f, enabled: v })} label="Accept online fee payments" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Key ID" hint="Razorpay Dashboard → Account & Settings → API Keys">
              <Input value={f.keyId} disabled={!editable} onChange={(e) => setF({ ...f, keyId: e.target.value.trim() })} placeholder="rzp_live_…" className="font-mono" />
            </Field>
            <Field label="Key Secret" hint={rz.hasKeySecret ? 'Saved — leave blank to keep it' : 'Shown once when you generate the key'}>
              <Input type="password" value={f.keySecret} disabled={!editable} onChange={(e) => setF({ ...f, keySecret: e.target.value })} placeholder={rz.hasKeySecret ? '••••••••••••' : ''} autoComplete="new-password" />
            </Field>
            <Field label="Webhook secret" hint={rz.hasWebhookSecret ? 'Saved — leave blank to keep it' : 'Optional, but recommended'}>
              <Input type="password" value={f.webhookSecret} disabled={!editable} onChange={(e) => setF({ ...f, webhookSecret: e.target.value })} placeholder={rz.hasWebhookSecret ? '••••••••' : ''} autoComplete="new-password" />
            </Field>
            <Field label="Webhook URL" hint="Add in Razorpay → Webhooks, event: payment.captured">
              <div className="flex gap-2">
                <Input readOnly value={rz.webhookUrl} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
                <Button
                  variant="secondary"
                  aria-label="Copy webhook URL"
                  onClick={() => {
                    navigator.clipboard.writeText(rz.webhookUrl);
                    toast.success('Copied');
                  }}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </Field>
          </div>
          {editable && (
            <div className="flex gap-2">
              <Button loading={save.isPending} disabled={!f.keyId} onClick={() => save.mutate()}>
                Save
              </Button>
              {rz.hasKeySecret && (
                <Button variant="secondary" icon={<ShieldCheck className="size-4" />} loading={verify.isPending} onClick={() => verify.mutate()}>
                  Test connection
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>
      <div className="space-y-6">
        <Card title="How it works">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-600">
            <li>Create a Razorpay account in the school's name and complete KYC.</li>
            <li>Paste the API keys here. Use test keys first to try it end to end.</li>
            <li>Parents see a <b>Pay online</b> button in the app, and fee reminders on WhatsApp include a pay link that works without logging in.</li>
            <li>Successful payments are allocated to the oldest dues automatically and a receipt is sent.</li>
          </ol>
        </Card>
        <Card title="WhatsApp, SMS & Email">
          <p className="mb-3 text-sm text-slate-600">Messaging uses the platform's verified WhatsApp number and SMS sender — no setup needed. Turn channels on and buy credits from the messaging page.</p>
          <LinkButton to="/messaging">Open messaging settings</LinkButton>
        </Card>
      </div>
    </div>
  );
}
