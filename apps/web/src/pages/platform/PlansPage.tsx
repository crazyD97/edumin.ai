import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Plus } from 'lucide-react';
import { ALL_FEATURES, FEATURES } from '@edumin/shared';
import { del, get, post, put } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { money, num } from '@/lib/format';
import { Badge, Button, Card, Checkbox, Field, Loading, PageHeader, confirm } from '@/components/ui';
import { FormModal } from '@/components/FormModal';

export function PlansPage() {
  const q = useQuery({ queryKey: ['plans'], queryFn: () => get<any[]>('/platform/plans') });
  const [editing, setEditing] = useState<any>(null);
  const remove = useAction((id: string) => del(`/platform/plans/${id}`), { success: 'Plan deleted', invalidate: [['plans']] });
  if (q.isLoading) return <Loading />;
  return (
    <>
      <PageHeader
        title="Subscription plans"
        description="Plans control pricing, limits and which modules a school can use."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ features: [...ALL_FEATURES], isActive: true, priceMonthly: 0, priceYearly: 0 })}>
            New plan
          </Button>
        }
      />
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {q.data?.map((p) => (
          <Card key={p.id} className="flex flex-col">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold">{p.name}</h3>
                <p className="text-sm text-slate-500">{p.description}</p>
              </div>
              {!p.isActive && <Badge>Inactive</Badge>}
            </div>
            <p className="mt-4 text-3xl font-semibold tracking-tight">
              {money(p.priceMonthly, { compact: true })}
              <span className="text-base font-normal text-slate-500">/month</span>
            </p>
            <p className="text-sm text-slate-500">{money(p.priceYearly, { compact: true })} billed yearly</p>
            <p className="mt-3 text-sm text-slate-600">
              {p.maxStudents ? `Up to ${num(p.maxStudents)} students` : 'Unlimited students'} · {p.maxStaff ? `${num(p.maxStaff)} staff` : 'unlimited staff'}
            </p>
            <ul className="mt-4 flex-1 space-y-1.5">
              {ALL_FEATURES.map((f) => (
                <li key={f} className={p.features.includes(f) ? 'flex items-center gap-2 text-sm text-slate-700' : 'flex items-center gap-2 text-sm text-slate-300 line-through'}>
                  <Check className="size-3.5" /> {FEATURES[f]}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4">
              <span className="text-sm text-slate-500">{p.schoolCount} schools</span>
              <div className="flex gap-1">
                {!p.schoolCount && (
                  <Button size="sm" variant="ghost" onClick={async () => (await confirm({ title: `Delete ${p.name}?`, danger: true })) && remove.mutate(p.id)}>
                    Delete
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>
                  Edit
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <FormModal
        open={!!editing}
        onClose={() => setEditing(null)}
        size="lg"
        title={editing?.id ? `Edit ${editing.name}` : 'New plan'}
        initial={editing ?? {}}
        fields={[
          { name: 'name', label: 'Name', required: true, span: 1 },
          { name: 'code', label: 'Code', required: true, span: 1, hint: 'lowercase, e.g. growth' },
          { name: 'description', label: 'Description' },
          { name: 'priceMonthly', label: 'Monthly price', type: 'number', span: 1 },
          { name: 'priceYearly', label: 'Yearly price', type: 'number', span: 1 },
          { name: 'maxStudents', label: 'Max students', type: 'number', span: 1, hint: 'Blank = unlimited' },
          { name: 'maxStaff', label: 'Max staff', type: 'number', span: 1 },
          { name: 'isActive', label: 'Available for new schools', type: 'checkbox' },
        ]}
        submit={(v) => {
          const body = { ...v, priceMonthly: Number(v.priceMonthly || 0), priceYearly: Number(v.priceYearly || 0), maxStudents: v.maxStudents ? Number(v.maxStudents) : null, maxStaff: v.maxStaff ? Number(v.maxStaff) : null, features: v.features ?? [] };
          return editing?.id ? put(`/platform/plans/${editing.id}`, body) : post('/platform/plans', body);
        }}
        success="Plan saved"
        invalidate={[['plans']]}
      >
        {(v, set) => (
          <Field label="Included modules" className="sm:col-span-2">
            <div className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-2">
              {ALL_FEATURES.map((f) => (
                <Checkbox key={f} checked={(v.features ?? []).includes(f)} onChange={(on) => set('features', on ? [...(v.features ?? []), f] : (v.features ?? []).filter((x: string) => x !== f))} label={FEATURES[f]} />
              ))}
            </div>
          </Field>
        )}
      </FormModal>
    </>
  );
}
