import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { IdCard, Plus, UserSquare2 } from 'lucide-react';
import { apiPage, del, get, openPdf, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useDebounced } from '@/lib/hooks';
import { ago } from '@/lib/format';
import { Avatar, Badge, Button, Card, EmptyState, PageHeader, Select, StatusBadge, confirm } from '@/components/ui';
import { DataTable, Toolbar } from '@/components/DataTable';
import { FormModal } from '@/components/FormModal';

export function StaffPage() {
  const { can, user, hasFeature } = useAuth();
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get('search') ?? '');
  const [roleKey, setRoleKey] = useState('');
  const [active, setActive] = useState('true');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<any>(null);
  const q = useDebounced(search);
  const params = { search: q, roleKey, active, page, pageSize: 25 };
  const list = useQuery({ queryKey: ['staff', params], queryFn: () => apiPage('/staff', params), placeholderData: keepPreviousData });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<any[]>('/roles'), enabled: can('users.view') });
  const staffRoles = (roles.data ?? []).filter((r) => !['student', 'parent'].includes(r.key));
  const deactivate = useAction((id: string) => del(`/staff/${id}`), { success: 'Staff member deactivated', invalidate: [['staff']] });

  return (
    <>
      <PageHeader
        title="Staff"
        description="Teachers, administrators and other staff accounts."
        actions={
          <>
          {hasFeature('certificates') && can('certificates.view') && (
            <Button variant="secondary" icon={<IdCard className="size-4" />} onClick={() => openPdf('/id-cards/staff')}>
              Print ID cards
            </Button>
          )}
          {can('staff.create') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ isActive: true })}>
              Add staff member
            </Button>
          )}
          </>
        }
      />
      <Card padded={false}>
        <Toolbar search={search} onSearch={setSearch} placeholder="Name, email or employee code">
          <Select value={roleKey} onChange={(e) => setRoleKey(e.target.value)} placeholder="All roles" options={staffRoles.map((r) => ({ value: r.key, label: r.name }))} />
          <Select
            value={active}
            onChange={(e) => setActive(e.target.value)}
            options={[
              { value: 'true', label: 'Active' },
              { value: 'false', label: 'Inactive' },
            ]}
            placeholder="All"
          />
        </Toolbar>
        <DataTable
          rows={list.data?.rows}
          loading={list.isLoading}
          error={list.error}
          rowKey={(r: any) => r.id}
          onRowClick={can('staff.edit') ? (r: any) => setEditing(r) : undefined}
          pagination={list.data ? { page, pageSize: 25, total: list.data.meta.total, onPage: setPage } : undefined}
          columns={[
            {
              key: 'name',
              header: 'Name',
              render: (r: any) => (
                <div className="flex items-center gap-3">
                  <Avatar name={r.fullName} src={r.avatarUrl} />
                  <div>
                    <p className="font-medium text-slate-900">{r.fullName}</p>
                    <p className="text-xs text-slate-500">{r.email}</p>
                  </div>
                </div>
              ),
            },
            { key: 'roleName', header: 'Role', render: (r: any) => <Badge tone="brand">{r.roleName}</Badge> },
            { key: 'designation', header: 'Designation', hideOnMobile: true },
            { key: 'employeeCode', header: 'Emp. code', hideOnMobile: true },
            { key: 'phone', header: 'Phone', hideOnMobile: true },
            { key: 'lastLoginAt', header: 'Last sign-in', render: (r: any) => (r.lastLoginAt ? ago(r.lastLoginAt) : 'Never'), hideOnMobile: true },
            { key: 'isActive', header: 'Status', render: (r: any) => <StatusBadge status={r.isActive ? 'active' : 'inactive'} /> },
            {
              key: 'x',
              header: '',
              align: 'right',
              render: (r: any) =>
                can('staff.delete') && r.isActive && r.id !== user?.id ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (await confirm({ title: `Deactivate ${r.fullName}?`, message: 'They will be signed out and can no longer log in. Their records are kept.', danger: true, confirmLabel: 'Deactivate' })) deactivate.mutate(r.id);
                    }}
                  >
                    Deactivate
                  </Button>
                ) : null,
            },
          ]}
          empty={<EmptyState icon={<UserSquare2 className="size-5" />} title="No staff found" />}
        />
      </Card>
      <FormModal
        open={!!editing}
        onClose={() => setEditing(null)}
        size="lg"
        title={editing?.id ? `Edit ${editing.fullName}` : 'Add staff member'}
        description={editing?.id ? undefined : 'They can sign in with this email and password straight away.'}
        initial={editing ?? {}}
        fields={[
          { name: 'fullName', label: 'Full name', required: true, span: 1 },
          { name: 'email', label: 'Email', type: 'email', required: true, span: 1 },
          { name: 'roleId', label: 'Role', type: 'select', required: true, options: staffRoles.map((r) => ({ value: r.id, label: r.name })), placeholder: 'Choose role', span: 1 },
          { name: 'phone', label: 'Phone', span: 1 },
          { name: 'password', label: editing?.id ? 'New password' : 'Password', type: 'text', required: !editing?.id, hint: editing?.id ? 'Leave blank to keep the current password' : 'At least 8 characters', span: 1 },
          { name: 'employeeCode', label: 'Employee code', span: 1 },
          { name: 'designation', label: 'Designation', span: 1 },
          { name: 'department', label: 'Department', span: 1 },
          { name: 'qualification', label: 'Qualification', span: 1 },
          { name: 'joinDate', label: 'Joining date', type: 'date', span: 1 },
          { name: 'gender', label: 'Gender', type: 'select', options: ['male', 'female', 'other'].map((g) => ({ value: g, label: g[0].toUpperCase() + g.slice(1) })), span: 1 },
          { name: 'address', label: 'Address', type: 'textarea' },
          { name: 'isActive', label: 'Account active', type: 'checkbox' },
        ]}
        submit={(v) => {
          const body = { ...v, password: v.password || undefined };
          return editing?.id ? put(`/staff/${editing.id}`, body) : post('/staff', body);
        }}
        success="Staff member saved"
        invalidate={[['staff'], ['teachers']]}
      />
    </>
  );
}
