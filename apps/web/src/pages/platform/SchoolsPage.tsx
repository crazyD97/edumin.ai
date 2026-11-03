import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import { SCHOOL_STATUSES } from '@edumin/shared';
import { apiPage, get, post } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { fmtDate, titleCase } from '@/lib/format';
import { Button, Card, EmptyState, PageHeader, Select, StatusBadge } from '@/components/ui';
import { DataTable, Toolbar } from '@/components/DataTable';
import { FormModal } from '@/components/FormModal';

export function SchoolsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search);
  const query = { search: q, status, page, pageSize: 25 };
  const list = useQuery({ queryKey: ['platform-schools', query], queryFn: () => apiPage('/platform/schools', query), placeholderData: keepPreviousData });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => get<any[]>('/platform/plans') });
  const creating = params.get('new') === '1';
  return (
    <>
      <PageHeader
        title="Schools"
        description="Every tenant, its plan and subscription state."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setParams({ new: '1' })}>
            Onboard school
          </Button>
        }
      />
      <Card padded={false}>
        <Toolbar search={search} onSearch={setSearch} placeholder="Name or subdomain">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All statuses" options={SCHOOL_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
        </Toolbar>
        <DataTable
          rows={list.data?.rows}
          loading={list.isLoading}
          rowKey={(r: any) => r.id}
          onRowClick={(r: any) => navigate(`/platform/schools/${r.id}`)}
          pagination={list.data ? { page, pageSize: 25, total: list.data.meta.total, onPage: setPage } : undefined}
          columns={[
            {
              key: 'name',
              header: 'School',
              render: (r: any) => (
                <div>
                  <p className="font-medium text-slate-900">{r.name}</p>
                  <p className="text-xs text-slate-500">{r.slug}</p>
                </div>
              ),
            },
            { key: 'planName', header: 'Plan', render: (r: any) => r.planName ?? '—' },
            { key: 'studentCount', header: 'Students', align: 'right' },
            { key: 'trialEndsAt', header: 'Trial / renewal', render: (r: any) => (r.status === 'trial' ? `Trial ends ${fmtDate(r.trialEndsAt)}` : r.subscriptionEndsAt ? `Renews ${fmtDate(r.subscriptionEndsAt)}` : '—'), hideOnMobile: true },
            { key: 'createdAt', header: 'Joined', render: (r: any) => fmtDate(r.createdAt), hideOnMobile: true },
            { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
          ]}
          empty={<EmptyState icon={<Building2 className="size-5" />} title="No schools yet" />}
        />
      </Card>
      <FormModal
        open={creating}
        onClose={() => setParams({})}
        size="lg"
        title="Onboard a school"
        description="Creates the tenant, default roles, an academic year, grading scale and the school admin account."
        initial={{ status: 'trial', trialDays: 30, planId: plans.data?.[0]?.id }}
        fields={[
          { name: 'name', label: 'School name', required: true },
          { name: 'slug', label: 'Subdomain / school code', required: true, hint: 'Lowercase letters, numbers and hyphens', span: 1 },
          { name: 'planId', label: 'Plan', type: 'select', options: (plans.data ?? []).map((p) => ({ value: p.id, label: p.name })), span: 1 },
          {
            name: 'status',
            label: 'Start as',
            type: 'select',
            required: true,
            span: 1,
            options: [
              { value: 'trial', label: 'Trial' },
              { value: 'active', label: 'Active (paid)' },
            ],
          },
          { name: 'trialDays', label: 'Trial length (days)', type: 'number', span: 1, hidden: (v) => v.status !== 'trial' },
          { name: 'email', label: 'School email', type: 'email', span: 1 },
          { name: 'phone', label: 'School phone', span: 1 },
          { name: 'adminName', label: 'Admin full name', required: true, span: 1 },
          { name: 'adminEmail', label: 'Admin email', type: 'email', required: true, span: 1 },
          { name: 'adminPassword', label: 'Admin password', required: true, hint: 'At least 8 characters — share it securely' },
        ]}
        submit={(v) => post('/platform/schools', { ...v, trialDays: Number(v.trialDays || 30), planId: v.planId || null })}
        success="School onboarded"
        invalidate={[['platform-schools'], ['platform-stats']]}
        onSaved={(r) => navigate(`/platform/schools/${r.id}`)}
      />
    </>
  );
}
