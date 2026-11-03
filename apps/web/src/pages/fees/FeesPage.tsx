import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BellRing, FileText, Plus, Receipt, Sparkles, Timer, Trash2, Search } from 'lucide-react';
import { FEE_FREQUENCIES, PAYMENT_METHODS } from '@edumin/shared';
import { apiPage, del, download, get, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useClasses, useDebounced, useSections, toOptions } from '@/lib/hooks';
import { fmtDate, fmtDateTime, money, titleCase } from '@/lib/format';
import { Badge, Button, Card, EmptyState, Input, Loading, PageHeader, Select, StatusBadge, Tabs, confirm, Avatar } from '@/components/ui';
import { DataTable, Toolbar } from '@/components/DataTable';
import { FormModal } from '@/components/FormModal';

type Tab = 'collect' | 'invoices' | 'payments' | 'structures' | 'concessions';

export function FeesPage() {
  const { user, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const kids = useQuery({ queryKey: ['my-students'], queryFn: () => get<any[]>('/students/mine'), enabled: user?.role.scope === 'own' });
  if (user?.role.scope === 'own') {
    if (kids.isLoading) return <Loading />;
    if (kids.data?.length === 1) return <Navigate to={`/fees/students/${kids.data[0].id}`} replace />;
    return (
      <>
        <PageHeader title="Fees" />
        <div className="grid gap-4 sm:grid-cols-2">
          {kids.data?.map((k) => (
            <a key={k.id} href={`/fees/students/${k.id}`} className="card flex items-center gap-3 p-5 hover:border-slate-300">
              <Avatar name={`${k.firstName} ${k.lastName}`} />
              <span className="font-medium">
                {k.firstName} {k.lastName}
              </span>
            </a>
          ))}
        </div>
      </>
    );
  }
  const tab = (params.get('tab') as Tab) ?? 'collect';
  return (
    <>
      <PageHeader title="Fees" description="Fee structures, invoices, collections and dues." actions={can('fees.edit') && <FeeActions />} />
      <Tabs
        tabs={[
          { value: 'collect', label: 'Collect' },
          { value: 'invoices', label: 'Invoices & dues' },
          { value: 'payments', label: 'Payments' },
          { value: 'structures', label: 'Fee structures' },
          { value: 'concessions', label: 'Concessions' },
        ]}
        value={tab}
        onChange={(t) => setParams({ tab: t })}
      />
      {tab === 'collect' && <Collect />}
      {tab === 'invoices' && <Invoices />}
      {tab === 'payments' && <Payments />}
      {tab === 'structures' && <Structures />}
      {tab === 'concessions' && <Concessions />}
    </>
  );
}

function FeeActions() {
  const gen = useAction(() => post('/fees/generate', {}), { success: (r: any) => (r.created ? `${r.created} invoices generated` : 'All invoices are already up to date'), invalidate: [['invoices']] });
  const late = useAction(() => post('/fees/late-fees'), { success: (r: any) => `Late fee applied to ${r.updated} overdue invoices`, invalidate: [['invoices']] });
  const remind = useAction(() => post('/fees/reminders', {}), { success: (r: any) => `Reminders sent for ${r.students} students` });
  return (
    <>
      <Button variant="secondary" icon={<BellRing className="size-4" />} loading={remind.isPending} onClick={async () => (await confirm({ title: 'Send fee reminders?', message: 'Parents of every student with overdue dues get an in-app notification and email.' })) && remind.mutate()}>
        Send reminders
      </Button>
      <Button variant="secondary" icon={<Timer className="size-4" />} loading={late.isPending} onClick={async () => (await confirm({ title: 'Apply late fees?', message: 'Adds each structure’s late fee to overdue invoices that don’t have one yet.' })) && late.mutate()}>
        Apply late fees
      </Button>
      <Button icon={<Sparkles className="size-4" />} loading={gen.isPending} onClick={() => gen.mutate()}>
        Generate invoices
      </Button>
    </>
  );
}

function Collect() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const list = useQuery({ queryKey: ['students', 'fee-search', q], queryFn: () => apiPage('/students', { search: q, pageSize: 10 }), enabled: q.length >= 2 });
  return (
    <Card>
      <div className="mx-auto max-w-xl py-6">
        <h3 className="text-center text-lg font-semibold">Collect a payment</h3>
        <p className="mt-1 mb-5 text-center text-sm text-slate-500">Find the student, review their dues and record the payment. A receipt is generated automatically.</p>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-slate-400" />
          <input autoFocus className="input h-12 pl-11 text-base" placeholder="Student name, admission no. or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {list.data && (
          <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
            {list.data.rows.length ? (
              list.data.rows.map((s: any) => (
                <li key={s.id}>
                  <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50" onClick={() => navigate(`/fees/students/${s.id}`)}>
                    <Avatar name={`${s.firstName} ${s.lastName}`} src={s.photoUrl} />
                    <span className="flex-1">
                      <span className="block text-sm font-medium text-slate-900">
                        {s.firstName} {s.lastName}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {s.admissionNo} · {s.className ? `${s.className} - ${s.sectionName}` : 'Not allocated'}
                      </span>
                    </span>
                    <span className="text-xs font-medium text-brand-700">Open ledger →</span>
                  </button>
                </li>
              ))
            ) : (
              <li className="px-4 py-6 text-center text-sm text-slate-500">No students found</li>
            )}
          </ul>
        )}
      </div>
    </Card>
  );
}

function Invoices() {
  const navigate = useNavigate();
  const classes = useClasses();
  const sections = useSections();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('outstanding');
  const [classId, setClassId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search);
  const params = { search: q, status, classId, sectionId, page, pageSize: 25 };
  const list = useQuery({ queryKey: ['invoices', params], queryFn: () => apiPage('/fees/invoices', params), placeholderData: keepPreviousData });
  return (
    <Card padded={false}>
      <Toolbar search={search} onSearch={setSearch} placeholder="Student or admission no.">
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          placeholder="All invoices"
          options={[
            { value: 'outstanding', label: 'Outstanding' },
            { value: 'overdue', label: 'Overdue' },
            { value: 'unpaid', label: 'Unpaid' },
            { value: 'partial', label: 'Partially paid' },
            { value: 'paid', label: 'Paid' },
            { value: 'cancelled', label: 'Cancelled' },
          ]}
        />
        <Select value={classId} onChange={(e) => (setClassId(e.target.value), setSectionId(''))} placeholder="All classes" options={toOptions(classes.data, (c) => c.name)} />
        <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)} placeholder="All sections" options={toOptions(sections.data?.filter((s) => !classId || s.classId === classId), (s) => s.label)} />
        {list.data?.summary && (
          <span className="ml-auto text-sm text-slate-600">
            Balance: <b className="tabular-nums">{money(list.data.summary.balance)}</b>
          </span>
        )}
      </Toolbar>
      <DataTable
        rows={list.data?.rows}
        loading={list.isLoading}
        error={list.error}
        rowKey={(r: any) => r.id}
        onRowClick={(r: any) => navigate(`/fees/students/${r.studentId}`)}
        pagination={list.data ? { page, pageSize: 25, total: list.data.meta.total, onPage: setPage } : undefined}
        columns={[
          {
            key: 'student',
            header: 'Student',
            render: (r: any) => (
              <div>
                <p className="font-medium text-slate-900">{r.studentName}</p>
                <p className="text-xs text-slate-500">
                  {r.admissionNo} · {r.className} {r.sectionName}
                </p>
              </div>
            ),
          },
          { key: 'title', header: 'Invoice' },
          { key: 'dueDate', header: 'Due', render: (r: any) => <span className={r.status !== 'paid' && r.dueDate < new Date().toISOString().slice(0, 10) ? 'text-red-600' : ''}>{fmtDate(r.dueDate)}</span> },
          { key: 'net', header: 'Amount', align: 'right', render: (r: any) => money(r.amount - r.discount - r.scholarship + r.lateFee), hideOnMobile: true },
          { key: 'paid', header: 'Paid', align: 'right', render: (r: any) => money(r.paid), hideOnMobile: true },
          { key: 'balance', header: 'Balance', align: 'right', render: (r: any) => <b className="tabular-nums">{money(r.balance)}</b> },
          { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
        ]}
        empty={<EmptyState icon={<FileText className="size-5" />} title="No invoices" description="Create fee structures, then click “Generate invoices”." />}
      />
    </Card>
  );
}

function Payments() {
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(search);
  const params = { search: q, method, from, to, page, pageSize: 25 };
  const list = useQuery({ queryKey: ['payments', params], queryFn: () => apiPage('/fees/payments', params), placeholderData: keepPreviousData });
  return (
    <Card padded={false}>
      <Toolbar search={search} onSearch={setSearch} placeholder="Receipt, student or admission no.">
        <Select value={method} onChange={(e) => setMethod(e.target.value)} placeholder="All methods" options={PAYMENT_METHODS.map((m) => ({ value: m, label: titleCase(m) }))} />
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        {list.data?.summary && (
          <span className="ml-auto text-sm text-slate-600">
            Total: <b className="tabular-nums">{money(list.data.summary.amount)}</b>
          </span>
        )}
      </Toolbar>
      <DataTable
        rows={list.data?.rows}
        loading={list.isLoading}
        rowKey={(r: any) => r.id}
        pagination={list.data ? { page, pageSize: 25, total: list.data.meta.total, onPage: setPage } : undefined}
        columns={[
          { key: 'receiptNo', header: 'Receipt', render: (r: any) => <span className="font-medium text-slate-900">{r.receiptNo}</span> },
          { key: 'paidAt', header: 'Date', render: (r: any) => fmtDateTime(r.paidAt) },
          { key: 'studentName', header: 'Student', render: (r: any) => `${r.studentName} (${r.admissionNo})` },
          { key: 'method', header: 'Method', render: (r: any) => titleCase(r.method), hideOnMobile: true },
          { key: 'receivedByName', header: 'Received by', hideOnMobile: true },
          { key: 'amount', header: 'Amount', align: 'right', render: (r: any) => <b className="tabular-nums">{money(r.amount)}</b> },
          { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
          {
            key: 'r',
            header: '',
            align: 'right',
            render: (r: any) =>
              r.status === 'completed' && (
                <Button size="sm" variant="ghost" icon={<Receipt className="size-4" />} onClick={() => download('GET', `/fees/payments/${r.id}/receipt`)}>
                  Receipt
                </Button>
              ),
          },
        ]}
        empty={<EmptyState title="No payments found" />}
      />
    </Card>
  );
}

function Structures() {
  const { can } = useAuth();
  const classes = useClasses();
  const heads = useQuery({ queryKey: ['fee-heads'], queryFn: () => get<any[]>('/fees/heads') });
  const list = useQuery({ queryKey: ['fee-structures'], queryFn: () => get<any[]>('/fees/structures') });
  const [editing, setEditing] = useState<any>(null);
  const [headOpen, setHeadOpen] = useState(false);
  const remove = useAction((id: string) => del(`/fees/structures/${id}`), { success: 'Structure deleted', invalidate: [['fee-structures']] });
  const gen = useAction((structureId: string) => post('/fees/generate', { structureId }), { success: (r: any) => `${r.created} invoices generated`, invalidate: [['fee-structures'], ['invoices']] });
  return (
    <Card padded={false}>
      <div className="flex flex-wrap justify-end gap-2 border-b border-slate-100 p-3">
        {can('fees.create') && (
          <>
            <Button variant="secondary" onClick={() => setHeadOpen(true)}>
              Fee heads
            </Button>
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ frequency: 'monthly', dueDay: 10, lateFeeAmount: 0, isActive: true, target: 'class' })}>
              Add structure
            </Button>
          </>
        )}
      </div>
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        rowKey={(r: any) => r.id}
        columns={[
          {
            key: 'name',
            header: 'Structure',
            render: (r: any) => (
              <div>
                <p className="font-medium text-slate-900">{r.name}</p>
                <p className="text-xs text-slate-500">{r.headName}</p>
              </div>
            ),
          },
          { key: 'applies', header: 'Applies to', render: (r: any) => (r.studentName ? <Badge tone="violet">{r.studentName}</Badge> : r.className) },
          { key: 'amount', header: 'Amount', align: 'right', render: (r: any) => money(r.amount) },
          { key: 'frequency', header: 'Frequency', render: (r: any) => titleCase(r.frequency) },
          { key: 'dueDay', header: 'Due day', align: 'right', hideOnMobile: true },
          { key: 'lateFeeAmount', header: 'Late fee', align: 'right', render: (r: any) => (r.lateFeeAmount ? money(r.lateFeeAmount) : '—'), hideOnMobile: true },
          { key: 'invoiceCount', header: 'Invoices', align: 'right', hideOnMobile: true },
          { key: 'isActive', header: 'Status', render: (r: any) => <StatusBadge status={r.isActive ? 'active' : 'inactive'} /> },
          {
            key: 'a',
            header: '',
            align: 'right',
            render: (r: any) => (
              <div className="flex justify-end gap-1">
                {can('fees.create') && r.isActive && (
                  <Button size="sm" variant="ghost" onClick={() => gen.mutate(r.id)}>
                    Generate
                  </Button>
                )}
                {can('fees.edit') && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ ...r, target: r.studentId ? 'student' : 'class' })}>
                    Edit
                  </Button>
                )}
                {can('fees.delete') && !r.invoiceCount && (
                  <Button size="sm" variant="ghost" onClick={async () => (await confirm({ title: `Delete ${r.name}?`, danger: true })) && remove.mutate(r.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ),
          },
        ]}
        empty={<EmptyState title="No fee structures" description="Add class-wise fees (tuition, transport…) or a fee for one student." />}
      />
      <FormModal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit fee structure' : 'Add fee structure'}
        description="Amount is per installment. Monthly fees create 12 invoices across the year, quarterly 4."
        initial={editing ?? {}}
        fields={[
          { name: 'name', label: 'Name', required: true, placeholder: 'Tuition Fee' },
          { name: 'feeHeadId', label: 'Fee head', type: 'select', required: true, options: toOptions(heads.data, (h) => h.name), placeholder: 'Choose', span: 1 },
          {
            name: 'target',
            label: 'Applies to',
            type: 'select',
            required: true,
            span: 1,
            options: [
              { value: 'class', label: 'A whole class' },
              { value: 'student', label: 'One student' },
            ],
          },
          { name: 'classId', label: 'Class', type: 'select', options: toOptions(classes.data, (c) => c.name), hidden: (v) => v.target === 'student', placeholder: 'Choose class' },
          { name: 'studentId', label: 'Student ID', hint: 'Open the student and copy the ID from the URL, or create from the fee ledger.', hidden: (v) => v.target !== 'student' },
          { name: 'amount', label: 'Amount per installment', type: 'number', required: true, span: 1 },
          { name: 'frequency', label: 'Frequency', type: 'select', required: true, options: FEE_FREQUENCIES.map((f) => ({ value: f, label: titleCase(f) })), span: 1 },
          { name: 'dueDay', label: 'Due day of month', type: 'number', span: 1 },
          { name: 'lateFeeAmount', label: 'Late fee', type: 'number', span: 1 },
          { name: 'isActive', label: 'Active', type: 'checkbox' },
        ]}
        submit={({ target, ...v }) => {
          const body = { ...v, amount: Number(v.amount), dueDay: Number(v.dueDay || 10), lateFeeAmount: Number(v.lateFeeAmount || 0), classId: target === 'class' ? v.classId : null, studentId: target === 'student' ? v.studentId : null };
          return editing?.id ? put(`/fees/structures/${editing.id}`, body) : post('/fees/structures', body);
        }}
        success="Fee structure saved"
        invalidate={[['fee-structures']]}
      />
      <HeadsModal open={headOpen} onClose={() => setHeadOpen(false)} heads={heads.data ?? []} />
    </Card>
  );
}

function HeadsModal({ open, onClose, heads }: { open: boolean; onClose: () => void; heads: any[] }) {
  const [name, setName] = useState('');
  const add = useAction(() => post('/fees/heads', { name }), { success: 'Fee head added', invalidate: [['fee-heads']], onSuccess: () => setName('') });
  const remove = useAction((id: string) => del(`/fees/heads/${id}`), { invalidate: [['fee-heads']] });
  return (
    <FormModal open={open} onClose={onClose} title="Fee heads" description="Categories used to group fees on invoices and reports." fields={[]} submit={async () => null} submitLabel="Done">
      {() => (
        <div className="sm:col-span-2">
          <ul className="mb-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {heads.map((h) => (
              <li key={h.id} className="flex items-center justify-between px-3 py-2 text-sm">
                {h.name}
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(h.id)} aria-label={`Delete ${h.name}`}>
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New fee head" />
            <Button disabled={name.length < 2} loading={add.isPending} onClick={() => add.mutate()}>
              Add
            </Button>
          </div>
        </div>
      )}
    </FormModal>
  );
}

function Concessions() {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['concessions'], queryFn: () => get<any[]>('/fees/concessions') });
  const remove = useAction((id: string) => del(`/fees/concessions/${id}`), { success: 'Concession removed', invalidate: [['concessions']] });
  return (
    <Card padded={false} subtitle="Add concessions from a student's fee ledger.">
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        rowKey={(r: any) => r.id}
        columns={[
          { key: 'studentName', header: 'Student', render: (r: any) => `${r.studentName} (${r.admissionNo})` },
          { key: 'kind', header: 'Type', render: (r: any) => <Badge tone={r.kind === 'scholarship' ? 'violet' : 'blue'}>{titleCase(r.kind)}</Badge> },
          { key: 'value', header: 'Value', render: (r: any) => (r.valueType === 'percent' ? `${r.value}%` : money(r.value)) },
          { key: 'headName', header: 'Applies to', render: (r: any) => r.headName ?? 'All fees' },
          { key: 'reason', header: 'Reason', hideOnMobile: true },
          {
            key: 'x',
            header: '',
            align: 'right',
            render: (r: any) =>
              can('fees.approve') && (
                <Button size="sm" variant="ghost" onClick={async () => (await confirm({ title: 'Remove this concession?', message: 'Unpaid invoices are recalculated.', danger: true })) && remove.mutate(r.id)}>
                  Remove
                </Button>
              ),
          },
        ]}
        empty={<EmptyState title="No concessions this year" description="Discounts and scholarships are added from a student’s fee ledger." />}
      />
    </Card>
  );
}
