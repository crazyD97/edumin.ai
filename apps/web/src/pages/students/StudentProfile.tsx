import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, LogOut, Pencil } from 'lucide-react';
import { get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useYears } from '@/lib/hooks';
import { fmtDate, money, pct, titleCase, today } from '@/lib/format';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, Input, KV, LinkButton, Loading, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, Stat } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { Documents } from '@/components/Documents';
import { BarsChart, ChartEmpty, TrendChart } from '@/components/charts';
import { StudentFormModal } from './StudentForm';
import { CertificatesPanel } from '../certificates/CertificatesPanel';

type Tab = 'overview' | 'history' | 'attendance' | 'results' | 'fees' | 'certificates' | 'documents';

export function StudentProfilePage() {
  const { id } = useParams();
  const { can, hasFeature, user } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [portal, setPortal] = useState<{ kind: 'student' | 'parent'; id: string; email: string } | null>(null);
  const q = useQuery({ queryKey: ['student', id], queryFn: () => get<any>(`/students/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={q.refetch} />;
  const s = q.data;
  const staff = user?.role.scope !== 'own';
  const tabs: { value: Tab; label: string }[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'history', label: 'Academic history' },
    ...(hasFeature('attendance') && can('attendance.view') ? [{ value: 'attendance' as Tab, label: 'Attendance' }] : []),
    ...(hasFeature('exams') && can('exams.view') ? [{ value: 'results' as Tab, label: 'Results' }] : []),
    ...(hasFeature('fees') && can('fees.view') ? [{ value: 'fees' as Tab, label: 'Fees' }] : []),
    ...(hasFeature('certificates') && can('certificates.view') && staff ? [{ value: 'certificates' as Tab, label: 'Certificates' }] : []),
    { value: 'documents', label: 'Documents' },
  ];

  return (
    <>
      <PageHeader
        back={staff ? { to: '/students', label: 'Students' } : undefined}
        title={
          <span className="flex items-center gap-3">
            <Avatar name={`${s.firstName} ${s.lastName}`} src={s.photoUrl} size={44} />
            <span>
              {s.firstName} {s.lastName}
            </span>
            <StatusBadge status={s.status} />
          </span>
        }
        description={`${s.admissionNo} · ${s.current ? `${s.current.className} - ${s.current.sectionName}, Roll ${s.current.rollNo ?? '—'}` : 'Not enrolled this year'}`}
        actions={
          can('students.edit') &&
          staff && (
            <>
              <Button variant="secondary" icon={<LogOut className="size-4" />} onClick={() => setStatusOpen(true)}>
                Change status
              </Button>
              <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            </>
          )
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="grid gap-6 xl:grid-cols-3">
          <Card title="Personal details" className="xl:col-span-2">
            <KV
              cols={3}
              items={[
                ['Date of birth', fmtDate(s.dateOfBirth)],
                ['Gender', titleCase(s.gender)],
                ['Blood group', s.bloodGroup],
                ['Phone', s.phone],
                ['Email', s.email],
                ['Admission date', fmtDate(s.admissionDate)],
                ['Nationality', s.nationality],
                ['Religion', s.religion],
                ['Previous school', s.previousSchool],
                ['Address', s.address],
                ['Medical notes', s.medicalNotes],
                ...(s.exitDate ? ([['Left on', `${fmtDate(s.exitDate)}${s.exitReason ? ` — ${s.exitReason}` : ''}`]] as [string, string][]) : []),
              ]}
            />
          </Card>
          <div className="space-y-6">
            <Card title="Parents & guardians" padded={false}>
              {s.guardians.length ? (
                <ul className="divide-y divide-slate-100">
                  {s.guardians.map((g: any) => (
                    <li key={g.id} className="px-5 py-3.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-slate-900">
                          {g.name} <span className="font-normal text-slate-500">· {titleCase(g.relation)}</span>
                        </p>
                        {g.isPrimary && <Badge tone="brand">Primary</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">{[g.phone, g.email, g.occupation].filter(Boolean).join(' · ')}</p>
                      {can('students.edit') && staff && (
                        <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline" onClick={() => setPortal({ kind: 'parent', id: g.id, email: g.email ?? '' })}>
                          <KeyRound className="size-3.5" /> {g.hasLogin ? 'Reset parent login' : 'Create parent login'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No guardians recorded" />
              )}
            </Card>
            {can('students.edit') && staff && (
              <Card title="Student portal">
                <p className="mb-3 text-sm text-slate-600">{s.hasLogin ? 'This student can sign in to view attendance, results and homework.' : 'No login yet.'}</p>
                <Button size="sm" variant="secondary" icon={<KeyRound className="size-4" />} onClick={() => setPortal({ kind: 'student', id: s.id, email: s.email ?? '' })}>
                  {s.hasLogin ? 'Reset login' : 'Create login'}
                </Button>
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === 'history' && (
        <Card padded={false}>
          <DataTable
            rowKey={(r: any) => r.id}
            rows={s.history}
            columns={[
              { key: 'academicYear', header: 'Academic year', render: (r: any) => <span className="font-medium text-slate-900">{r.academicYear}</span> },
              { key: 'class', header: 'Class', render: (r: any) => `${r.className} - ${r.sectionName}` },
              { key: 'rollNo', header: 'Roll no.', align: 'right' },
              { key: 'status', header: 'Outcome', render: (r: any) => <StatusBadge status={r.status} /> },
            ]}
            empty={<EmptyState title="No enrollment history" />}
          />
        </Card>
      )}
      {tab === 'attendance' && <AttendanceTab studentId={s.id} />}
      {tab === 'results' && <ResultsTab studentId={s.id} />}
      {tab === 'fees' && <FeesTab studentId={s.id} />}
      {tab === 'certificates' && <CertificatesPanel studentId={s.id} studentStatus={s.status} />}
      {tab === 'documents' && (
        <Card title="Documents">
          <Documents entity="student" entityId={s.id} canUpload={can('students.edit') && staff} canDelete={can('students.edit') && staff} />
        </Card>
      )}

      <StudentFormModal open={editing} onClose={() => setEditing(false)} student={s} />
      <StatusModal open={statusOpen} onClose={() => setStatusOpen(false)} student={s} />
      <PortalModal target={portal} onClose={() => setPortal(null)} />
    </>
  );
}

function AttendanceTab({ studentId }: { studentId: string }) {
  const years = useYears();
  const cur = years.data?.find((y) => y.isCurrent);
  const [yearId, setYearId] = useState('');
  const year = years.data?.find((y) => y.id === yearId) ?? cur;
  const to = year ? (year.endDate < today() ? year.endDate : today()) : today();
  const q = useQuery({ queryKey: ['student-attendance', studentId, year?.id], queryFn: () => get<any>(`/attendance/students/${studentId}`, { from: year!.startDate, to }), enabled: !!year });
  if (!year || q.isLoading) return <Loading />;
  const st = q.data?.stats;
  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Select className="w-48" value={year.id} onChange={(e) => setYearId(e.target.value)} options={(years.data ?? []).map((y) => ({ value: y.id, label: y.name }))} />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Attendance" value={pct(st?.percentage)} tone={st && st.percentage < 75 ? 'red' : 'green'} />
        <Stat label="Days recorded" value={st?.total ?? 0} />
        <Stat label="Absent" value={st?.absent ?? 0} tone="red" />
        <Stat label="Late" value={st?.late ?? 0} tone="amber" />
        <Stat label="Half day" value={st?.halfDay ?? 0} tone="violet" />
      </div>
      <Card title="Monthly attendance">
        {q.data?.monthly.length ? <BarsChart data={q.data.monthly} xKey="month" series={[{ key: 'percentage', label: 'Attendance %' }]} format={(v) => `${v}%`} /> : <ChartEmpty />}
      </Card>
      <Card title="Absences & late arrivals" padded={false}>
        <DataTable
          rowKey={(r: any) => r.date}
          rows={q.data?.records.filter((r: any) => r.status !== 'present')}
          columns={[
            { key: 'date', header: 'Date', render: (r: any) => fmtDate(r.date) },
            { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            { key: 'remarks', header: 'Remarks' },
          ]}
          empty={<EmptyState title="Perfect attendance" description="No absences or late arrivals in this period." />}
        />
      </Card>
    </div>
  );
}

export function ResultsTab({ studentId }: { studentId: string }) {
  const q = useQuery({ queryKey: ['exam-history', studentId], queryFn: () => get<any[]>(`/students/${studentId}/exam-history`) });
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <Card><EmptyState title="No examination results yet" /></Card>;
  const chart = q.data.filter((r) => r.percentage !== null).map((r) => ({ label: `${r.examName.replace(' Examination', '')} ${r.academicYear}`, percentage: r.percentage }));
  return (
    <div className="space-y-6">
      <Card title="Performance over time">
        <TrendChart data={chart} xKey="label" series={[{ key: 'percentage', label: 'Percentage' }]} format={(v) => `${v}%`} yDomain={[0, 100]} />
      </Card>
      <Card padded={false}>
        <DataTable
          rowKey={(r: any) => r.examId}
          rows={q.data}
          columns={[
            { key: 'academicYear', header: 'Year' },
            { key: 'examName', header: 'Examination', render: (r: any) => <Link className="font-medium text-brand-700 hover:underline" to={`/exams/${r.examId}`}>{r.examName}</Link> },
            { key: 'className', header: 'Class' },
            { key: 'percentage', header: '%', align: 'right', render: (r: any) => pct(r.percentage) },
            { key: 'grade', header: 'Grade', align: 'center' },
            { key: 'rank', header: 'Rank', align: 'right' },
            { key: 'passed', header: 'Result', render: (r: any) => <StatusBadge status={r.passed ? 'pass' : 'fail'} label={r.passed ? 'Pass' : 'Fail'} /> },
          ]}
        />
      </Card>
    </div>
  );
}

function FeesTab({ studentId }: { studentId: string }) {
  const q = useQuery({ queryKey: ['ledger', studentId], queryFn: () => get<any>(`/fees/students/${studentId}/ledger`) });
  if (q.isLoading) return <Loading />;
  const sm = q.data.summary;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Billed (net)" value={money(sm.gross - sm.concessions + sm.lateFees)} />
        <Stat label="Paid" value={money(sm.paid)} tone="green" />
        <Stat label="Balance" value={money(sm.balance)} tone="amber" />
        <Stat label="Overdue" value={money(sm.overdue)} tone="red" />
      </div>
      <div className="flex justify-end">
        <LinkButton to={`/fees/students/${studentId}`} variant="primary">
          Open fee ledger
        </LinkButton>
      </div>
    </div>
  );
}

function StatusModal({ open, onClose, student }: { open: boolean; onClose: () => void; student: any }) {
  const [status, setStatus] = useState('transferred');
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const save = useAction(() => post(`/students/${student.id}/status`, { status, date, reason }), { success: 'Status updated', invalidate: [['student'], ['students']], onSuccess: onClose });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change student status"
      description="Transfer and withdrawal keep the full academic history and deactivate portal access."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={['transferred', 'withdrawn'].includes(status) ? 'danger' : 'primary'} loading={save.isPending} onClick={() => save.mutate()}>
            Update status
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="New status">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: 'transferred', label: 'Transferred to another school' },
              { value: 'withdrawn', label: 'Withdrawn' },
              { value: 'graduated', label: 'Graduated' },
              { value: 'inactive', label: 'Inactive (temporarily)' },
              { value: 'active', label: 'Active' },
            ].filter((o) => o.value !== student.status)}
          />
        </Field>
        {['transferred', 'withdrawn', 'graduated'].includes(status) && (
          <>
            <Field label="Effective date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Reason / destination school">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

function PortalModal({ target, onClose }: { target: { kind: 'student' | 'parent'; id: string; email: string } | null; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const save = useAction(() => post(target!.kind === 'student' ? `/students/${target!.id}/portal-account` : `/guardians/${target!.id}/portal-account`, { email: email || target!.email, password }), {
    success: 'Login saved — share the credentials securely',
    invalidate: [['student']],
    onSuccess: () => {
      setPassword('');
      onClose();
    },
  });
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      size="sm"
      title={target?.kind === 'student' ? 'Student login' : 'Parent login'}
      description="The account can only see this family's information."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={password.length < 8} onClick={() => save.mutate()}>
            Save login
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Email (used to sign in)">
          <Input type="email" defaultValue={target?.email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 8 characters">
          <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
