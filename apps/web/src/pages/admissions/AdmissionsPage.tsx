import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ExternalLink, Plus } from 'lucide-react';
import { APPLICATION_STATUSES, ENQUIRY_STATUSES } from '@edumin/shared';
import { apiPage, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useClasses, useDebounced, toOptions } from '@/lib/hooks';
import { fmtDate, titleCase } from '@/lib/format';
import { Button, Card, Field, Input, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea } from '@/components/ui';
import { DataTable, Toolbar } from '@/components/DataTable';

type Tab = 'applications' | 'enquiries';

export function AdmissionsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'applications';
  const { can, school } = useAuth();
  return (
    <>
      <PageHeader
        title="Admissions"
        description="Track enquiries and applications from first contact to enrolment."
        actions={
          school && (
            <a href={`/apply/${school.slug}`} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <ExternalLink className="size-4" /> Public admission form
            </a>
          )
        }
      />
      <Tabs
        tabs={[
          { value: 'applications', label: 'Applications' },
          { value: 'enquiries', label: 'Enquiries' },
        ]}
        value={tab}
        onChange={(t) => setParams({ tab: t })}
      />
      {tab === 'applications' ? <Applications canCreate={can('admissions.create')} /> : <Enquiries canCreate={can('admissions.create')} canEdit={can('admissions.edit')} />}
    </>
  );
}

function Applications({ canCreate }: { canCreate: boolean }) {
  const navigate = useNavigate();
  const classes = useClasses();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [classId, setClassId] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search);
  const params = { search: q, status, classId, page, pageSize: 25 };
  const list = useQuery({ queryKey: ['applications', params], queryFn: () => apiPage('/admissions/applications', params), placeholderData: keepPreviousData });
  return (
    <Card padded={false}>
      <Toolbar search={search} onSearch={setSearch} placeholder="Application no., student or guardian">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All statuses" options={APPLICATION_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
        <Select value={classId} onChange={(e) => setClassId(e.target.value)} placeholder="All classes" options={toOptions(classes.data, (c) => c.name)} />
        <div className="flex-1" />
        {canCreate && (
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            New application
          </Button>
        )}
      </Toolbar>
      <DataTable
        rows={list.data?.rows}
        loading={list.isLoading}
        error={list.error}
        rowKey={(r: any) => r.id}
        onRowClick={(r: any) => navigate(`/admissions/applications/${r.id}`)}
        pagination={list.data ? { page, pageSize: 25, total: list.data.meta.total, onPage: setPage } : undefined}
        columns={[
          { key: 'applicationNo', header: 'Application', render: (r: any) => <span className="font-medium text-slate-900">{r.applicationNo}</span> },
          { key: 'student', header: 'Student', render: (r: any) => `${r.student.firstName} ${r.student.lastName ?? ''}` },
          { key: 'className', header: 'Class' },
          { key: 'guardian', header: 'Guardian', render: (r: any) => r.guardian.name, hideOnMobile: true },
          { key: 'phone', header: 'Phone', render: (r: any) => r.guardian.phone, hideOnMobile: true },
          { key: 'createdAt', header: 'Received', render: (r: any) => fmtDate(r.createdAt), hideOnMobile: true },
          { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
        ]}
      />
      <ApplicationModal open={creating} onClose={() => setCreating(false)} onDone={(id) => navigate(`/admissions/applications/${id}`)} />
    </Card>
  );
}

export function ApplicationModal({ open, onClose, onDone, enquiry }: { open: boolean; onClose: () => void; onDone: (id: string) => void; enquiry?: any }) {
  const classes = useClasses();
  const [f, setF] = useState<any>({});
  const v = (k: string, d = '') => f[k] ?? d;
  const set = (k: string) => (e: { target: { value: string } }) => setF((p: any) => ({ ...p, [k]: e.target.value }));
  const save = useAction(
    () =>
      post<{ id: string }>('/admissions/applications', {
        classId: v('classId', enquiry?.classId ?? ''),
        enquiryId: enquiry?.id,
        student: { firstName: v('firstName', enquiry?.studentName?.split(' ')[0] ?? ''), lastName: v('lastName', enquiry?.studentName?.split(' ').slice(1).join(' ') ?? ''), dateOfBirth: v('dob'), gender: v('gender'), previousSchool: v('previousSchool') },
        guardian: { name: v('gName', enquiry?.guardianName ?? ''), relation: v('relation', 'father'), phone: v('phone', enquiry?.phone ?? ''), email: v('email', enquiry?.email ?? '') },
      }),
    {
      success: 'Application created',
      invalidate: [['applications'], ['enquiries']],
      onSuccess: (r) => {
        setF({});
        onClose();
        onDone(r.id);
      },
    },
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={enquiry ? 'Convert enquiry to application' : 'New application'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Create application
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Student first name" required>
          <Input value={v('firstName', enquiry?.studentName?.split(' ')[0] ?? '')} onChange={set('firstName')} />
        </Field>
        <Field label="Last name">
          <Input value={v('lastName', enquiry?.studentName?.split(' ').slice(1).join(' ') ?? '')} onChange={set('lastName')} />
        </Field>
        <Field label="Class applied for" required>
          <Select value={v('classId', enquiry?.classId ?? '')} onChange={set('classId')} placeholder="Choose class" options={toOptions(classes.data, (c) => c.name)} />
        </Field>
        <Field label="Date of birth">
          <Input type="date" value={v('dob')} onChange={set('dob')} />
        </Field>
        <Field label="Gender">
          <Select value={v('gender')} onChange={set('gender')} placeholder="Select" options={['male', 'female', 'other'].map((g) => ({ value: g, label: titleCase(g) }))} />
        </Field>
        <Field label="Previous school">
          <Input value={v('previousSchool')} onChange={set('previousSchool')} />
        </Field>
        <Field label="Guardian name" required>
          <Input value={v('gName', enquiry?.guardianName ?? '')} onChange={set('gName')} />
        </Field>
        <Field label="Relation">
          <Select value={v('relation', 'father')} onChange={set('relation')} options={['father', 'mother', 'guardian'].map((g) => ({ value: g, label: titleCase(g) }))} />
        </Field>
        <Field label="Guardian phone" required>
          <Input value={v('phone', enquiry?.phone ?? '')} onChange={set('phone')} />
        </Field>
        <Field label="Guardian email">
          <Input type="email" value={v('email', enquiry?.email ?? '')} onChange={set('email')} />
        </Field>
      </div>
    </Modal>
  );
}

function Enquiries({ canCreate, canEdit }: { canCreate: boolean; canEdit: boolean }) {
  const navigate = useNavigate();
  const classes = useClasses();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [converting, setConverting] = useState<any>(null);
  const q = useDebounced(search);
  const params = { search: q, status, page, pageSize: 25 };
  const list = useQuery({ queryKey: ['enquiries', params], queryFn: () => apiPage('/admissions/enquiries', params), placeholderData: keepPreviousData });
  const update = useAction(({ id, status }: { id: string; status: string }) => patch(`/admissions/enquiries/${id}`, { status }), { invalidate: [['enquiries']], success: 'Enquiry updated' });
  const [f, setF] = useState<any>({});
  const create = useAction(() => post('/admissions/enquiries', { ...f, source: f.source || 'walk_in' }), {
    success: 'Enquiry recorded',
    invalidate: [['enquiries']],
    onSuccess: () => {
      setF({});
      setCreating(false);
    },
  });
  return (
    <Card padded={false}>
      <Toolbar search={search} onSearch={setSearch} placeholder="Name or phone">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All statuses" options={ENQUIRY_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
        <div className="flex-1" />
        {canCreate && (
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            Record enquiry
          </Button>
        )}
      </Toolbar>
      <DataTable
        rows={list.data?.rows}
        loading={list.isLoading}
        error={list.error}
        rowKey={(r: any) => r.id}
        pagination={list.data ? { page, pageSize: 25, total: list.data.meta.total, onPage: setPage } : undefined}
        columns={[
          {
            key: 'studentName',
            header: 'Enquiry',
            render: (r: any) => (
              <div>
                <p className="font-medium text-slate-900">{r.studentName}</p>
                <p className="max-w-64 truncate text-xs text-slate-500">{r.message}</p>
              </div>
            ),
          },
          { key: 'className', header: 'Class' },
          { key: 'guardian', header: 'Contact', render: (r: any) => <span>{r.guardianName} · {r.phone}</span>, hideOnMobile: true },
          { key: 'source', header: 'Source', render: (r: any) => titleCase(r.source), hideOnMobile: true },
          { key: 'createdAt', header: 'Date', render: (r: any) => fmtDate(r.createdAt), hideOnMobile: true },
          {
            key: 'status',
            header: 'Status',
            render: (r: any) =>
              canEdit && r.status !== 'converted' ? (
                <Select className="w-36" value={r.status} onChange={(e) => update.mutate({ id: r.id, status: e.target.value })} options={ENQUIRY_STATUSES.filter((s) => s !== 'converted').map((s) => ({ value: s, label: titleCase(s) }))} />
              ) : (
                <StatusBadge status={r.status} />
              ),
          },
          {
            key: 'convert',
            header: '',
            align: 'right',
            render: (r: any) =>
              canCreate && r.status !== 'converted' && r.status !== 'closed' ? (
                <Button size="sm" variant="subtle" onClick={() => setConverting(r)}>
                  Start application
                </Button>
              ) : null,
          },
        ]}
      />
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Record enquiry"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button loading={create.isPending} onClick={() => create.mutate()}>
              Save
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Student name" required>
            <Input value={f.studentName ?? ''} onChange={(e) => setF({ ...f, studentName: e.target.value })} />
          </Field>
          <Field label="Class">
            <Select value={f.classId ?? ''} onChange={(e) => setF({ ...f, classId: e.target.value })} placeholder="Choose" options={toOptions(classes.data, (c) => c.name)} />
          </Field>
          <Field label="Guardian name" required>
            <Input value={f.guardianName ?? ''} onChange={(e) => setF({ ...f, guardianName: e.target.value })} />
          </Field>
          <Field label="Phone" required>
            <Input value={f.phone ?? ''} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={f.email ?? ''} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <Field label="Source">
            <Select value={f.source ?? 'walk_in'} onChange={(e) => setF({ ...f, source: e.target.value })} options={['walk_in', 'phone', 'website', 'referral', 'event'].map((s) => ({ value: s, label: titleCase(s) }))} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea value={f.message ?? ''} onChange={(e) => setF({ ...f, message: e.target.value })} />
          </Field>
        </div>
      </Modal>
      <ApplicationModal open={!!converting} enquiry={converting} onClose={() => setConverting(null)} onDone={(id) => navigate(`/admissions/applications/${id}`)} />
    </Card>
  );
}
