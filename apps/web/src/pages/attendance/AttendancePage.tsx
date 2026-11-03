import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { addMonths, format } from 'date-fns';
import { BellRing, Check, ChevronLeft, ChevronRight, Plus, Save } from 'lucide-react';
import { ATTENDANCE_STATUSES } from '@edumin/shared';
import { get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useSections, toOptions } from '@/lib/hooks';
import { fmtDate, isoDate, pct, titleCase, today } from '@/lib/format';
import { Avatar, Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, NoSections, PageHeader, Select, Stat, StatusBadge, Tabs, Textarea, clsx } from '@/components/ui';
import { DataTable } from '@/components/DataTable';

type Tab = 'mark' | 'register' | 'low' | 'staff' | 'leave' | 'mine';

const SHORT: Record<string, string> = { present: 'P', absent: 'A', late: 'L', half_day: 'H' };
const CHIP: Record<string, string> = {
  present: 'bg-emerald-500 text-white',
  absent: 'bg-red-500 text-white',
  late: 'bg-amber-500 text-white',
  half_day: 'bg-violet-500 text-white',
};

export function AttendancePage() {
  const { can, user, hasFeature } = useAuth();
  const [params, setParams] = useSearchParams();
  const family = user?.role.scope === 'own';
  const tabs: { value: Tab; label: string }[] = family
    ? [
        { value: 'mine', label: 'Attendance' },
        { value: 'leave', label: 'Leave requests' },
      ]
    : [
        ...(can('attendance.create') ? [{ value: 'mark' as Tab, label: 'Mark attendance' }] : []),
        { value: 'register', label: 'Monthly register' },
        { value: 'low', label: 'Low attendance' },
        ...(can('staff.edit') ? [{ value: 'staff' as Tab, label: 'Staff attendance' }] : []),
        ...(can('leave.view') ? [{ value: 'leave' as Tab, label: 'Leave requests' }] : []),
      ];
  const tab = (params.get('tab') as Tab) ?? tabs[0].value;
  if (!hasFeature('attendance') && tab !== 'leave') return <EmptyState title="Attendance is not enabled for your plan" />;
  return (
    <>
      <PageHeader title="Attendance" description={family ? 'Daily attendance and leave.' : 'Mark daily attendance, review registers and manage leave.'} />
      <Tabs tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === 'mark' && <MarkAttendance initialSection={params.get('section') ?? ''} />}
      {tab === 'register' && <Register />}
      {tab === 'low' && <LowAttendance />}
      {tab === 'staff' && <StaffAttendance />}
      {tab === 'leave' && <Leave />}
      {tab === 'mine' && <FamilyAttendance />}
    </>
  );
}

function MarkAttendance({ initialSection }: { initialSection: string }) {
  const sections = useSections();
  const [sectionId, setSectionId] = useState(initialSection);
  const [date, setDate] = useState(today());
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [notify, setNotify] = useState(true);
  useEffect(() => {
    if (!sectionId && sections.data?.length) setSectionId(sections.data[0].id);
  }, [sections.data, sectionId]);
  const sheet = useQuery({ queryKey: ['attendance-sheet', sectionId, date], queryFn: () => get<any>('/attendance/sheet', { sectionId, date }), enabled: !!sectionId });
  useEffect(() => {
    if (sheet.data) setMarks(Object.fromEntries(sheet.data.students.map((s: any) => [s.studentId, s.status ?? (s.onLeave ? 'absent' : 'present')])));
  }, [sheet.data]);
  const save = useAction(
    () =>
      post('/attendance/mark', {
        sectionId,
        date,
        notifyAbsent: notify,
        records: Object.entries(marks).map(([studentId, status]) => ({ studentId, status, remarks: sheet.data.students.find((s: any) => s.studentId === studentId)?.onLeave ? 'On approved leave' : null })),
      }),
    { success: (r: any) => `Saved · ${r.present} present, ${r.absent} absent`, invalidate: [['attendance-sheet'], ['dashboard']] },
  );
  const counts = useMemo(() => Object.values(marks).reduce<Record<string, number>>((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {}), [marks]);
  const setAll = (status: string) => setMarks((m) => Object.fromEntries(Object.keys(m).map((k) => [k, status])));

  return (
    <Card padded={false}>
      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 lg:flex-row lg:items-end">
        <Field label="Class" className="lg:w-64">
          <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)} placeholder="Choose section" options={toOptions(sections.data, (s) => s.label)} />
        </Field>
        <Field label="Date" className="lg:w-48">
          <Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2 lg:ml-auto">
          <Button variant="secondary" size="sm" icon={<Check className="size-4" />} onClick={() => setAll('present')}>
            All present
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAll('absent')}>
            All absent
          </Button>
        </div>
      </div>
      {sections.data && !sections.data.length ? (
        <NoSections />
      ) : sheet.isLoading || !sectionId ? (
        <Loading />
      ) : !sheet.data?.students.length ? (
        <EmptyState title="No students enrolled in this section" />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 bg-slate-50/70 px-4 py-2.5 text-xs">
            {sheet.data.isMarked ? <Badge tone="green">Already marked — saving will update it</Badge> : <Badge tone="amber">Not marked yet</Badge>}
            {ATTENDANCE_STATUSES.map((s) => (
              <span key={s} className="text-slate-600">
                {titleCase(s)}: <b className="tabular-nums">{counts[s] ?? 0}</b>
              </span>
            ))}
          </div>
          <ul className="divide-y divide-slate-100">
            {sheet.data.students.map((s: any) => (
              <li key={s.studentId} className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="w-7 text-right text-xs text-slate-400 tabular-nums">{s.rollNo}</span>
                  <Avatar name={`${s.firstName} ${s.lastName}`} src={s.photoUrl} size={30} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {s.firstName} {s.lastName}
                    </p>
                    <p className="text-xs text-slate-500">{s.admissionNo}</p>
                  </div>
                  {s.onLeave && <Badge tone="violet">On leave</Badge>}
                </div>
                <div className="flex gap-1.5 pl-10 sm:pl-0" role="radiogroup" aria-label={`Attendance for ${s.firstName}`}>
                  {ATTENDANCE_STATUSES.map((st) => (
                    <button
                      key={st}
                      type="button"
                      role="radio"
                      aria-checked={marks[s.studentId] === st}
                      title={titleCase(st)}
                      onClick={() => setMarks((m) => ({ ...m, [s.studentId]: st }))}
                      className={clsx('h-8 w-10 rounded-md text-xs font-semibold transition', marks[s.studentId] === st ? CHIP[st] : 'bg-slate-100 text-slate-500 hover:bg-slate-200')}
                    >
                      {SHORT[st]}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <div className="sticky bottom-0 flex flex-col gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="accent-[var(--brand)]" /> Notify parents of absent students
            </label>
            <Button icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate()}>
              Save attendance
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function Register() {
  const sections = useSections();
  const [sectionId, setSectionId] = useState('');
  const [month, setMonth] = useState(format(new Date(), 'yyyy-MM'));
  useEffect(() => {
    if (!sectionId && sections.data?.length) setSectionId(sections.data[0].id);
  }, [sections.data, sectionId]);
  const q = useQuery({ queryKey: ['register', sectionId, month], queryFn: () => get<any>('/attendance/register', { sectionId, month }), enabled: !!sectionId });
  const shift = (n: number) => setMonth(format(addMonths(new Date(month + '-01T00:00:00'), n), 'yyyy-MM'));
  const days = Array.from({ length: q.data?.daysInMonth ?? 30 }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
        <Select className="w-56" value={sectionId} onChange={(e) => setSectionId(e.target.value)} options={toOptions(sections.data, (s) => s.label)} />
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => shift(-1)} aria-label="Previous month">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="w-32 text-center text-sm font-medium">{format(new Date(month + '-01T00:00:00'), 'MMMM yyyy')}</span>
          <Button size="sm" variant="ghost" onClick={() => shift(1)} aria-label="Next month">
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="ml-auto flex gap-3 text-xs text-slate-500">
          {Object.entries(SHORT).map(([k, v]) => (
            <span key={k} className="flex items-center gap-1">
              <span className={clsx('grid size-4 place-items-center rounded text-[9px] font-bold', CHIP[k])}>{v}</span>
              {titleCase(k)}
            </span>
          ))}
        </div>
      </div>
      {sections.data && !sections.data.length ? (
        <NoSections />
      ) : q.isLoading ? (
        <Loading />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50/70">
              <tr>
                <th className="th sticky left-0 z-10 bg-slate-50">Student</th>
                {days.map((d) => (
                  <th key={d} className={clsx('px-1 py-2 text-center font-medium text-slate-500', new Date(d + 'T00:00:00').getDay() === 0 && 'bg-slate-100')}>
                    {Number(d.slice(8))}
                  </th>
                ))}
                <th className="th text-right">%</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {q.data?.students.map((s: any) => (
                <tr key={s.studentId}>
                  <td className="sticky left-0 z-10 bg-white px-4 py-1.5 text-sm font-medium whitespace-nowrap text-slate-800">
                    {s.firstName} {s.lastName}
                  </td>
                  {days.map((d) => {
                    const st = s.days[d];
                    return (
                      <td key={d} className={clsx('px-0.5 py-1 text-center', new Date(d + 'T00:00:00').getDay() === 0 && 'bg-slate-50')}>
                        {st ? <span className={clsx('inline-grid size-5 place-items-center rounded text-[9px] font-bold', CHIP[st])}>{SHORT[st]}</span> : <span className="text-slate-200">·</span>}
                      </td>
                    );
                  })}
                  <td className={clsx('px-4 text-right font-semibold tabular-nums', s.stats && s.stats.percentage < 75 ? 'text-red-600' : 'text-slate-800')}>{s.stats ? pct(s.stats.percentage) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function LowAttendance() {
  const { school, can } = useAuth();
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 30 * 86400_000)));
  const [to, setTo] = useState(today());
  const [threshold, setThreshold] = useState(String(school?.settings.lowAttendanceThreshold ?? 75));
  const sections = useSections();
  const [sectionId, setSectionId] = useState('');
  const q = useQuery({ queryKey: ['low-att', from, to, threshold, sectionId], queryFn: () => get<any>('/attendance/low', { from, to, threshold, sectionId }) });
  const alert = useAction(() => post('/attendance/low/alerts', { from, to, threshold: Number(threshold), sectionId: sectionId || null }), { success: (r: any) => `Alerts sent to ${r.notified} parents/students` });
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 p-4">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Below (%)">
          <Input type="number" className="w-24" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </Field>
        <Field label="Section">
          <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)} placeholder="All" options={toOptions(sections.data, (s) => s.label)} />
        </Field>
        {can('attendance.edit') && (
          <Button className="ml-auto" variant="secondary" icon={<BellRing className="size-4" />} disabled={!q.data?.students.length} loading={alert.isPending} onClick={() => alert.mutate()}>
            Alert parents
          </Button>
        )}
      </div>
      <DataTable
        rows={q.data?.students}
        loading={q.isLoading}
        rowKey={(r: any) => r.studentId}
        columns={[
          { key: 'name', header: 'Student', render: (r: any) => <span className="font-medium text-slate-900">{r.name}</span> },
          { key: 'cls', header: 'Class', render: (r: any) => `${r.className} - ${r.sectionName}` },
          { key: 'total', header: 'Days', align: 'right' },
          { key: 'absent', header: 'Absent', align: 'right' },
          { key: 'percentage', header: 'Attendance', align: 'right', render: (r: any) => <span className="font-semibold text-red-600">{pct(r.percentage)}</span> },
        ]}
        empty={<EmptyState title="No students below the threshold" description="Everyone is attending regularly in this period." />}
      />
    </Card>
  );
}

function StaffAttendance() {
  const [date, setDate] = useState(today());
  const q = useQuery({ queryKey: ['staff-att', date], queryFn: () => get<any[]>('/attendance/staff', { date }) });
  const [marks, setMarks] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.data) setMarks(Object.fromEntries(q.data.map((s) => [s.userId, s.status ?? 'present'])));
  }, [q.data]);
  const save = useAction(() => post('/attendance/staff', { date, records: Object.entries(marks).map(([userId, status]) => ({ userId, status })) }), { success: 'Staff attendance saved', invalidate: [['staff-att']] });
  return (
    <Card padded={false}>
      <div className="flex items-end gap-3 border-b border-slate-100 p-4">
        <Field label="Date">
          <Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Button className="ml-auto" icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-slate-100">
          {q.data?.map((s) => (
            <li key={s.userId} className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center">
              <div className="flex flex-1 items-center gap-3">
                <Avatar name={s.fullName} size={30} />
                <div>
                  <p className="text-sm font-medium text-slate-900">{s.fullName}</p>
                  <p className="text-xs text-slate-500">{s.designation ?? s.roleName}</p>
                </div>
                {!s.status && <Badge tone="amber">Unmarked</Badge>}
              </div>
              <div className="flex gap-1.5 pl-10 sm:pl-0">
                {ATTENDANCE_STATUSES.map((st) => (
                  <button key={st} type="button" title={titleCase(st)} onClick={() => setMarks((m) => ({ ...m, [s.userId]: st }))} className={clsx('h-8 w-10 rounded-md text-xs font-semibold', marks[s.userId] === st ? CHIP[st] : 'bg-slate-100 text-slate-500 hover:bg-slate-200')}>
                    {SHORT[st]}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Leave() {
  const { can, user } = useAuth();
  const family = user?.role.scope === 'own';
  const [status, setStatus] = useState(family ? '' : 'pending');
  const [applying, setApplying] = useState(false);
  const q = useQuery({ queryKey: ['leave', status], queryFn: () => get<any[]>('/leave', { status }) });
  const review = useAction(({ id, s }: { id: string; s: string }) => post(`/leave/${id}/review`, { status: s }), { success: 'Leave request updated', invalidate: [['leave'], ['dashboard']] });
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
        <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All" options={['pending', 'approved', 'rejected', 'cancelled'].map((s) => ({ value: s, label: titleCase(s) }))} />
        <div className="flex-1" />
        {can('leave.create') && (
          <Button icon={<Plus className="size-4" />} onClick={() => setApplying(true)}>
            Apply for leave
          </Button>
        )}
      </div>
      <DataTable
        rows={q.data}
        loading={q.isLoading}
        rowKey={(r: any) => r.id}
        columns={[
          {
            key: 'who',
            header: 'For',
            render: (r: any) => (
              <div>
                <p className="font-medium text-slate-900">{r.studentName ?? r.requesterName}</p>
                <p className="text-xs text-slate-500">{r.studentId ? `Requested by ${r.requesterName}` : 'Staff leave'}</p>
              </div>
            ),
          },
          { key: 'dates', header: 'Dates', render: (r: any) => (r.fromDate === r.toDate ? fmtDate(r.fromDate) : `${fmtDate(r.fromDate)} → ${fmtDate(r.toDate)}`) },
          { key: 'type', header: 'Type', render: (r: any) => titleCase(r.type), hideOnMobile: true },
          { key: 'reason', header: 'Reason', render: (r: any) => <span className="block max-w-72 truncate">{r.reason}</span>, hideOnMobile: true },
          { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
          {
            key: 'actions',
            header: '',
            align: 'right',
            render: (r: any) =>
              r.status === 'pending' ? (
                <div className="flex justify-end gap-1">
                  {r.requesterId === user?.id ? (
                    <Button size="sm" variant="ghost" onClick={() => review.mutate({ id: r.id, s: 'cancelled' })}>
                      Cancel
                    </Button>
                  ) : (
                    can('leave.approve') && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => review.mutate({ id: r.id, s: 'rejected' })}>
                          Reject
                        </Button>
                        <Button size="sm" variant="subtle" onClick={() => review.mutate({ id: r.id, s: 'approved' })}>
                          Approve
                        </Button>
                      </>
                    )
                  )}
                </div>
              ) : null,
          },
        ]}
        empty={<EmptyState title="No leave requests" />}
      />
      <ApplyLeaveModal open={applying} onClose={() => setApplying(false)} />
    </Card>
  );
}

function ApplyLeaveModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const family = user?.role.scope === 'own';
  const kids = useQuery({ queryKey: ['my-students'], queryFn: () => get<any[]>('/students/mine'), enabled: open && user?.role.key === 'parent' });
  const [f, setF] = useState({ studentId: '', fromDate: today(), toDate: today(), type: family ? 'sick' : 'casual', reason: '' });
  const save = useAction(() => post('/leave', { ...f, studentId: f.studentId || kids.data?.[0]?.id || null }), { success: 'Leave request submitted', invalidate: [['leave']], onSuccess: onClose });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Apply for leave"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Submit
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {user?.role.key === 'parent' && (kids.data?.length ?? 0) > 1 && (
          <Field label="Child" className="sm:col-span-2">
            <Select value={f.studentId} onChange={(e) => setF({ ...f, studentId: e.target.value })} options={(kids.data ?? []).map((k) => ({ value: k.id, label: `${k.firstName} ${k.lastName}` }))} />
          </Field>
        )}
        <Field label="From">
          <Input type="date" value={f.fromDate} onChange={(e) => setF({ ...f, fromDate: e.target.value })} />
        </Field>
        <Field label="To">
          <Input type="date" value={f.toDate} onChange={(e) => setF({ ...f, toDate: e.target.value })} />
        </Field>
        <Field label="Type" className="sm:col-span-2">
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} options={['sick', 'casual', 'family', 'medical', 'other'].map((t) => ({ value: t, label: titleCase(t) }))} />
        </Field>
        <Field label="Reason" className="sm:col-span-2" required>
          <Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function FamilyAttendance() {
  const { school } = useAuth();
  const kids = useQuery({ queryKey: ['my-students'], queryFn: () => get<any[]>('/students/mine') });
  const [studentId, setStudentId] = useState('');
  const sid = studentId || kids.data?.[0]?.id;
  const year = useQuery({ queryKey: ['years'], queryFn: () => get<any[]>('/academic-years') });
  const cur = year.data?.find((y) => y.isCurrent);
  const q = useQuery({ queryKey: ['student-attendance', sid, cur?.id], queryFn: () => get<any>(`/attendance/students/${sid}`, { from: cur.startDate, to: today() }), enabled: !!sid && !!cur });
  if (kids.isLoading || q.isLoading) return <Loading />;
  const st = q.data?.stats;
  const threshold = school?.settings.lowAttendanceThreshold ?? 75;
  return (
    <div className="space-y-6">
      {(kids.data?.length ?? 0) > 1 && (
        <Select className="w-64" value={sid} onChange={(e) => setStudentId(e.target.value)} options={(kids.data ?? []).map((k) => ({ value: k.id, label: `${k.firstName} ${k.lastName}` }))} />
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="This year" value={pct(st?.percentage)} sub={`Required: ${threshold}%`} tone={st && st.percentage < threshold ? 'red' : 'green'} />
        <Stat label="Days present" value={st ? st.present + st.late : 0} sub={`of ${st?.total ?? 0} school days`} />
        <Stat label="Absent" value={st?.absent ?? 0} tone="red" />
        <Stat label="Late / half day" value={`${st?.late ?? 0} / ${st?.halfDay ?? 0}`} tone="amber" />
      </div>
      <Card title="Recent attendance" padded={false}>
        <DataTable
          rows={q.data?.records.slice(0, 40)}
          rowKey={(r: any) => r.date}
          columns={[
            { key: 'date', header: 'Date', render: (r: any) => fmtDate(r.date) },
            { key: 'day', header: 'Day', render: (r: any) => format(new Date(r.date + 'T00:00:00'), 'EEEE') },
            { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            { key: 'remarks', header: 'Remarks' },
          ]}
          empty={<EmptyState title="No attendance recorded yet" />}
        />
      </Card>
    </div>
  );
}
