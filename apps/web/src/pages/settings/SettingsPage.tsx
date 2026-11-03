import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Check, ImageUp, Plus, Save, ShieldCheck } from 'lucide-react';
import { ACTIONS, DAYS, MODULES, DATA_SCOPES } from '@edumin/shared';
import { ApiError, get, patch, post, put, upload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { applyBranding } from '@/lib/branding';
import { useAction } from '@/lib/hooks';
import { schoolUrl } from '@/lib/tenant';
import { Avatar, Badge, Button, Card, Checkbox, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea, clsx } from '@/components/ui';

type Tab = 'branding' | 'general' | 'roles' | 'profile';

export function SettingsPage() {
  const { can, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const school = !!user?.school;
  const tabs: { value: Tab; label: string }[] = [
    ...(school && can('settings.view') ? [{ value: 'branding' as Tab, label: 'School & branding' }, { value: 'general' as Tab, label: 'General' }] : []),
    ...(school && can('users.view') ? [{ value: 'roles' as Tab, label: 'Roles & permissions' }] : []),
    { value: 'profile', label: 'My profile' },
  ];
  const tab = (params.get('tab') as Tab) ?? tabs[0].value;
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === 'branding' && <Branding />}
      {tab === 'general' && <General />}
      {tab === 'roles' && <Roles />}
      {tab === 'profile' && <Profile />}
    </>
  );
}

function ImageField({ label, value, onChange, hint, disabled }: { label: string; value?: string | null; onChange: (url: string | null) => void; hint?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-3">
        <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">{value ? <img src={value} alt="" className="size-full object-contain" /> : <ImageUp className="size-5 text-slate-300" />}</div>
        {!disabled && (
          <div className="flex gap-2">
            <label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              {busy ? 'Uploading…' : 'Upload'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setBusy(true);
                  try {
                    onChange((await upload(f, { entity: 'branding' })).url);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </label>
            {value && (
              <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
    </Field>
  );
}

function Branding() {
  const { school, can, refresh } = useAuth();
  const editable = can('settings.edit');
  const [f, setF] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (school) setF({ name: school.name, ...school.branding });
  }, [school]);
  // Restore the saved brand when leaving without saving.
  useEffect(() => () => applyBranding(school), [school]);
  // Live preview of colours while editing
  useEffect(() => {
    if (f.primaryColor) applyBranding({ name: f.name, branding: f });
  }, [f.primaryColor, f.secondaryColor, f.accentColor, f.name, f]);
  const save = useAction(() => put('/school/branding', f), {
    success: 'Branding saved',
    onSuccess: () => refresh(),
    onError: (e: ApiError) => setErrors(e.fieldErrors),
  });
  if (!school) return <Loading />;
  const set = (k: string) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const text = (k: string, label: string, opts: { area?: boolean; hint?: string; type?: string } = {}) => (
    <Field label={label} error={errors[k]} hint={opts.hint}>
      {opts.area ? <Textarea rows={2} value={f[k] ?? ''} onChange={set(k)} disabled={!editable} /> : <Input type={opts.type} value={f[k] ?? ''} onChange={set(k)} disabled={!editable} />}
    </Field>
  );
  const color = (k: string, label: string) => (
    <Field label={label} error={errors[k]}>
      <div className="flex items-center gap-2">
        <input type="color" disabled={!editable} value={f[k] ?? '#000000'} onChange={set(k)} className="h-9 w-11 cursor-pointer rounded-lg border border-slate-300 bg-white p-0.5" />
        <Input value={f[k] ?? ''} onChange={set(k)} disabled={!editable} className="font-mono" />
      </div>
    </Field>
  );
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <Card title="School identity">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">{text('name', 'School name')}</div>
            <ImageField label="Logo" value={f.logoUrl} onChange={(v) => setF({ ...f, logoUrl: v })} hint="Square PNG/JPG works best; used on PDFs too" disabled={!editable} />
            <ImageField label="Favicon" value={f.faviconUrl} onChange={(v) => setF({ ...f, faviconUrl: v })} hint="Browser tab icon" disabled={!editable} />
            {color('primaryColor', 'Primary colour')}
            {color('secondaryColor', 'Secondary colour')}
            {color('accentColor', 'Accent colour')}
          </div>
        </Card>
        <Card title="Contact details">
          <div className="grid gap-4 sm:grid-cols-2">
            {text('email', 'Email', { type: 'email' })}
            {text('phone', 'Phone')}
            {text('website', 'Website')}
            {text('principalName', 'Principal name', { hint: 'Printed on report cards' })}
            <div className="sm:col-span-2">{text('address', 'Address', { area: true })}</div>
          </div>
        </Card>
        <Card title="Login page">
          <div className="grid gap-4 sm:grid-cols-2">
            {text('loginTitle', 'Headline')}
            {text('loginSubtitle', 'Sub-headline')}
            <ImageField label="Background image" value={f.loginImageUrl} onChange={(v) => setF({ ...f, loginImageUrl: v })} disabled={!editable} />
            <Field label="Your sign-in address" hint="Share this with parents, students and staff">
              <Input readOnly value={schoolUrl(school.slug)} onFocus={(e) => e.target.select()} />
            </Field>
          </div>
        </Card>
        <Card title="Documents">
          <div className="grid gap-4 sm:grid-cols-2">
            {text('reportCardHeader', 'Report card header', { area: true, hint: 'Shown under the school name' })}
            {text('reportCardFooter', 'Report card footer', { area: true })}
            {text('receiptHeader', 'Receipt header', { area: true })}
            {text('receiptFooter', 'Receipt footer', { area: true, hint: 'e.g. refund policy' })}
          </div>
        </Card>
      </div>
      <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
        <Card title="Preview" padded={false}>
          <div className="overflow-hidden rounded-b-xl">
            <div className="p-5 text-white" style={{ background: `linear-gradient(135deg, ${f.primaryColor}, ${f.secondaryColor})` }}>
              <div className="flex items-center gap-2.5">
                {f.logoUrl ? <img src={f.logoUrl} alt="" className="size-9 rounded-lg bg-white/90 object-contain p-0.5" /> : <span className="grid size-9 place-items-center rounded-lg bg-white/20 font-bold">{f.name?.[0]}</span>}
                <span className="font-semibold">{f.name}</span>
              </div>
              <p className="mt-6 text-lg font-semibold">{f.loginTitle || f.name}</p>
              <p className="text-sm text-white/80">{f.loginSubtitle}</p>
            </div>
            <div className="space-y-2 p-5">
              <div className="flex gap-2">
                <span className="rounded-lg px-3 py-1.5 text-sm font-medium text-white" style={{ background: f.primaryColor }}>
                  Primary button
                </span>
                <span className="rounded-lg px-3 py-1.5 text-sm font-medium" style={{ background: f.accentColor, color: '#111' }}>
                  Accent
                </span>
              </div>
              <p className="text-xs text-slate-500">Colours update across the app as you edit.</p>
            </div>
          </div>
        </Card>
        {editable && (
          <Button className="w-full" icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate()}>
            Save branding
          </Button>
        )}
      </div>
    </div>
  );
}

function General() {
  const { school, can, refresh } = useAuth();
  const editable = can('settings.edit');
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (school) setF({ ...school.settings });
  }, [school]);
  const save = useAction(() => put('/school/settings', { ...f, lowAttendanceThreshold: Number(f.lowAttendanceThreshold) }), { success: 'Settings saved', onSuccess: () => refresh() });
  if (!f) return <Loading />;
  const set = (k: string) => (e: { target: { value: string } }) => setF((p: any) => ({ ...p, [k]: e.target.value }));
  return (
    <Card title="General settings" actions={editable && <Button icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Admission number format" hint="Tokens: {YYYY} {YY} {MM} {SEQ:4}">
          <Input value={f.admissionNoFormat} onChange={set('admissionNoFormat')} disabled={!editable} className="font-mono" />
        </Field>
        <Field label="Receipt number format">
          <Input value={f.receiptNoFormat} onChange={set('receiptNoFormat')} disabled={!editable} className="font-mono" />
        </Field>
        <Field label="Application number format">
          <Input value={f.applicationNoFormat} onChange={set('applicationNoFormat')} disabled={!editable} className="font-mono" />
        </Field>
        <Field label="Low attendance threshold (%)">
          <Input type="number" value={f.lowAttendanceThreshold} onChange={set('lowAttendanceThreshold')} disabled={!editable} />
        </Field>
        <Field label="Currency">
          <Select value={f.currency} onChange={set('currency')} disabled={!editable} options={['INR', 'USD', 'GBP', 'EUR', 'AED', 'SGD', 'KES', 'NGN', 'ZAR', 'AUD'].map((c) => ({ value: c, label: c }))} />
        </Field>
        <Field label="Time zone">
          <Input value={f.timezone} onChange={set('timezone')} disabled={!editable} />
        </Field>
        <Field label="Working days" className="sm:col-span-2 lg:col-span-3">
          <div className="flex flex-wrap gap-4 pt-1">
            {[...DAYS, { value: 7, label: 'Sunday', short: 'Sun' }].map((d) => (
              <Checkbox key={d.value} disabled={!editable} checked={f.workingDays.includes(d.value)} onChange={(on) => setF({ ...f, workingDays: on ? [...f.workingDays, d.value].sort() : f.workingDays.filter((x: number) => x !== d.value) })} label={d.label} />
            ))}
          </div>
        </Field>
      </div>
    </Card>
  );
}

function Roles() {
  const { can } = useAuth();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<any[]>('/roles') });
  const [selected, setSelected] = useState<string>('');
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newRole, setNewRole] = useState({ name: '', scope: 'school', description: '' });
  const role = roles.data?.find((r) => r.id === selected) ?? roles.data?.[0];
  useEffect(() => {
    if (role) setPerms(new Set(role.permissions));
  }, [role]);
  const locked = role?.key === 'school_admin' || !can('users.edit');
  const save = useAction(() => put(`/roles/${role.id}`, { name: role.name, scope: role.scope, description: role.description, permissions: [...perms] }), { success: 'Permissions saved', invalidate: [['roles']] });
  const create = useAction(() => post<any>('/roles', { ...newRole, permissions: [] }), {
    success: 'Role created',
    invalidate: [['roles']],
    onSuccess: (r) => {
      setSelected(r.id);
      setCreating(false);
    },
  });
  if (roles.isLoading) return <Loading />;
  const toggle = (p: string) => setPerms((s) => (s.has(p) ? (s.delete(p), new Set(s)) : new Set(s.add(p))));
  const toggleRow = (m: string) => {
    const all = ACTIONS.every((a) => perms.has(`${m}.${a}`));
    setPerms((s) => {
      const n = new Set(s);
      ACTIONS.forEach((a) => (all ? n.delete(`${m}.${a}`) : n.add(`${m}.${a}`)));
      return n;
    });
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      <Card padded={false} className="h-fit">
        <ul className="p-2">
          {roles.data?.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => setSelected(r.id)} className={clsx('flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm', r.id === role?.id ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-700 hover:bg-slate-100')}>
                <span>{r.name}</span>
                <span className="text-xs text-slate-400">{r.userCount}</span>
              </button>
            </li>
          ))}
        </ul>
        {can('users.create') && (
          <div className="border-t border-slate-100 p-2">
            <Button variant="ghost" size="sm" className="w-full" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Custom role
            </Button>
          </div>
        )}
      </Card>
      {role && (
        <Card
          title={
            <span className="flex items-center gap-2">
              {role.name} {role.isSystem && <Badge>System</Badge>}
            </span>
          }
          subtitle={`Data scope: ${role.scope === 'school' ? 'entire school' : role.scope === 'assigned' ? 'assigned classes only' : 'own / own children only'}`}
          actions={!locked && <Button icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}
          padded={false}
        >
          {role.key === 'school_admin' && (
            <p className="flex items-center gap-2 bg-slate-50 px-5 py-2.5 text-sm text-slate-600">
              <ShieldCheck className="size-4" /> School admins always have full access.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-slate-50/70">
                <tr>
                  <th className="th">Module</th>
                  {ACTIONS.map((a) => (
                    <th key={a} className="th text-center">
                      {a}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {Object.entries(MODULES).map(([m, label]) => (
                  <tr key={m}>
                    <td className="td">
                      <button type="button" disabled={locked} className="font-medium text-slate-800 disabled:cursor-default" onClick={() => toggleRow(m)}>
                        {label}
                      </button>
                    </td>
                    {ACTIONS.map((a) => {
                      const p = `${m}.${a}`;
                      const on = perms.has(p);
                      return (
                        <td key={a} className="px-2 py-2 text-center">
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => toggle(p)}
                            aria-label={`${label} ${a}`}
                            aria-pressed={on}
                            className={clsx('inline-grid size-6 place-items-center rounded-md border transition', on ? 'border-brand bg-brand text-white' : 'border-slate-300 bg-white text-transparent hover:border-slate-400', locked && 'opacity-70')}
                          >
                            <Check className="size-3.5" />
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create custom role"
        description="e.g. Librarian, Receptionist, Vice Principal. Assign permissions after creating it."
        footer={
          <Button disabled={newRole.name.length < 2} loading={create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
        }
      >
        <div className="space-y-4">
          <Field label="Role name">
            <Input value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} />
          </Field>
          <Field label="Data scope" hint="Which records can people with this role see?">
            <Select value={newRole.scope} onChange={(e) => setNewRole({ ...newRole, scope: e.target.value })} options={DATA_SCOPES.map((s) => ({ value: s, label: s === 'school' ? 'Entire school' : s === 'assigned' ? 'Assigned classes only' : 'Own records only' }))} />
          </Field>
          <Field label="Description">
            <Textarea value={newRole.description} onChange={(e) => setNewRole({ ...newRole, description: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

function Profile() {
  const { user, refresh } = useAuth();
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [phone, setPhone] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? null);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const saveProfile = useAction(() => patch('/auth/profile', { fullName, phone: phone || undefined, avatarUrl }), { success: 'Profile updated', onSuccess: () => refresh() });
  const changePw = useAction(() => post('/auth/change-password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword }), {
    success: 'Password changed. Other devices have been signed out.',
    onSuccess: () => setPw({ currentPassword: '', newPassword: '', confirm: '' }),
  });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Profile">
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Avatar name={fullName} src={avatarUrl} size={56} />
            {user?.school && (
              <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                Change photo
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={async (e) => e.target.files?.[0] && setAvatarUrl((await upload(e.target.files[0], { entity: 'avatar' })).url)} />
              </label>
            )}
          </div>
          <Field label="Full name">
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </Field>
          <Field label="Email">
            <Input value={user?.email} disabled />
          </Field>
          <Field label="Phone">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <p className="text-sm text-slate-500">
            Role: <b>{user?.role.name}</b>
            {user?.school ? ` · ${user.school.name}` : ''}
          </p>
          <Button loading={saveProfile.isPending} onClick={() => saveProfile.mutate()}>
            Save profile
          </Button>
        </div>
      </Card>
      <Card title="Change password">
        <div className="space-y-4">
          <Field label="Current password">
            <Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} autoComplete="current-password" />
          </Field>
          <Field label="New password" hint="At least 8 characters">
            <Input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} autoComplete="new-password" />
          </Field>
          <Field label="Confirm new password" error={pw.confirm && pw.confirm !== pw.newPassword ? 'Passwords do not match' : undefined}>
            <Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" />
          </Field>
          <Button disabled={pw.newPassword.length < 8 || pw.newPassword !== pw.confirm} loading={changePw.isPending} onClick={() => changePw.mutate()}>
            Update password
          </Button>
        </div>
      </Card>
    </div>
  );
}

