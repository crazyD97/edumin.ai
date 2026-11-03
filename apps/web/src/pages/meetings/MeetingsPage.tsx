import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus, Clock, Handshake, MapPin, Plus, Trash2 } from 'lucide-react';
import { del, get, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useTeachers } from '@/lib/hooks';
import { fmtDate, fmtDateTime, isoDate, today } from '@/lib/format';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, clsx } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { format } from 'date-fns';

type Tab = 'upcoming' | 'past' | 'slots';

export function MeetingsPage() {
  const { user, can } = useAuth();
  const family = user?.role.scope === 'own';
  const [tab, setTab] = useState<Tab>('upcoming');
  const [booking, setBooking] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [open, setOpen] = useState<any>(null);
  const q = useQuery({ queryKey: ['meetings', tab], queryFn: () => get<any[]>('/meetings', { scope: tab === 'slots' ? 'upcoming' : tab }), enabled: tab !== 'slots' });
  return (
    <>
      <PageHeader
        title="Parent–teacher meetings"
        description={family ? "Book time with your child's teachers." : 'Publish availability, approve requests and keep meeting notes.'}
        actions={
          family
            ? can('meetings.create') && (
                <Button icon={<CalendarPlus className="size-4" />} onClick={() => setBooking(true)}>
                  Book a meeting
                </Button>
              )
            : can('meetings.create') && (
                <Button icon={<Plus className="size-4" />} onClick={() => setScheduling(true)}>
                  Schedule meeting
                </Button>
              )
        }
      />
      <Tabs
        tabs={[
          { value: 'upcoming', label: 'Upcoming' },
          { value: 'past', label: 'History' },
          ...(!family && user?.role.scope === 'assigned' ? [{ value: 'slots' as Tab, label: 'My availability' }] : []),
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'slots' ? (
        <Slots />
      ) : (
        <Card padded={false}>
          <DataTable
            rows={q.data}
            loading={q.isLoading}
            rowKey={(r: any) => r.id}
            onRowClick={(r: any) => setOpen(r)}
            columns={[
              { key: 'startsAt', header: 'When', render: (r: any) => <span className="font-medium text-slate-900">{fmtDateTime(r.startsAt)}</span> },
              { key: 'student', header: 'Student', render: (r: any) => (r.studentName ? `${r.studentName}${r.classLabel ? ` · ${r.classLabel}` : ''}` : '—') },
              { key: 'with', header: family ? 'Teacher' : 'Parent', render: (r: any) => (family ? r.teacherName : (r.parentName ?? '—')) },
              ...(user?.role.scope === 'school' ? [{ key: 'teacherName', header: 'Teacher', hideOnMobile: true }] : []),
              { key: 'agenda', header: 'Agenda', render: (r: any) => <span className="block max-w-64 truncate">{r.agenda ?? '—'}</span>, hideOnMobile: true },
              { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            ]}
            empty={<EmptyState icon={<Handshake className="size-5" />} title={tab === 'upcoming' ? 'No upcoming meetings' : 'No past meetings'} />}
          />
        </Card>
      )}
      <MeetingModal meeting={open} onClose={() => setOpen(null)} />
      {family && <BookModal open={booking} onClose={() => setBooking(false)} />}
      {!family && <ScheduleModal open={scheduling} onClose={() => setScheduling(false)} />}
    </>
  );
}

function MeetingModal({ meeting, onClose }: { meeting: any; onClose: () => void }) {
  const { user, can } = useAuth();
  const [notes, setNotes] = useState('');
  useEffect(() => setNotes(meeting?.notes ?? ''), [meeting]);
  const update = useAction((body: any) => patch(`/meetings/${meeting.id}`, body), { success: 'Meeting updated', invalidate: [['meetings'], ['dashboard']], onSuccess: onClose });
  if (!meeting) return null;
  const teacherSide = meeting.teacherId === user?.id || user?.role.scope === 'school';
  const active = ['requested', 'approved'].includes(meeting.status);
  return (
    <Modal
      open
      onClose={onClose}
      title="Meeting"
      description={fmtDateTime(meeting.startsAt)}
      footer={
        <>
          {active && (
            <Button variant="ghost" className="mr-auto" onClick={() => update.mutate({ status: 'cancelled' })}>
              Cancel meeting
            </Button>
          )}
          {teacherSide && meeting.status === 'requested' && can('meetings.approve') && (
            <>
              <Button variant="secondary" onClick={() => update.mutate({ status: 'rejected' })}>
                Decline
              </Button>
              <Button onClick={() => update.mutate({ status: 'approved' })}>Approve</Button>
            </>
          )}
          {teacherSide && meeting.status === 'approved' && (
            <Button onClick={() => update.mutate({ status: 'completed', notes })}>Mark completed</Button>
          )}
          {teacherSide && ['completed'].includes(meeting.status) && <Button onClick={() => update.mutate({ notes })}>Save notes</Button>}
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-2">
          <StatusBadge status={meeting.status} />
          {meeting.location && (
            <Badge>
              <MapPin className="size-3" /> {meeting.location}
            </Badge>
          )}
        </div>
        <p>
          <span className="text-slate-500">Student:</span> {meeting.studentName ?? '—'} {meeting.classLabel && `(${meeting.classLabel})`}
        </p>
        <p>
          <span className="text-slate-500">Teacher:</span> {meeting.teacherName} · <span className="text-slate-500">Parent:</span> {meeting.parentName ?? '—'}
        </p>
        {meeting.agenda && (
          <div>
            <p className="label">Agenda</p>
            <p className="rounded-lg bg-slate-50 p-3 text-slate-700">{meeting.agenda}</p>
          </div>
        )}
        {teacherSide ? (
          <Field label="Meeting notes" hint="Visible to staff only">
            <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}

function BookModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const kids = useQuery({ queryKey: ['my-students'], queryFn: () => get<any[]>('/students/mine'), enabled: open });
  const [studentId, setStudentId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [slotId, setSlotId] = useState('');
  const [agenda, setAgenda] = useState('');
  const sid = studentId || kids.data?.[0]?.id;
  const teachers = useQuery({ queryKey: ['meeting-teachers', sid], queryFn: () => get<any[]>('/meetings/teachers', { studentId: sid }), enabled: !!sid && open });
  const slots = useQuery({
    queryKey: ['slots', teacherId],
    queryFn: () => get<any[]>('/meetings/slots', { teacherId, from: today(), to: isoDate(new Date(Date.now() + 45 * 86400_000)), onlyFree: 'true' }),
    enabled: !!teacherId,
  });
  const book = useAction(() => post('/meetings', { studentId: sid, slotId, agenda }), {
    success: 'Request sent — the teacher will confirm',
    invalidate: [['meetings'], ['slots']],
    onSuccess: () => {
      setSlotId('');
      setAgenda('');
      onClose();
    },
  });
  const byDay = (slots.data ?? []).reduce<Record<string, any[]>>((a, s) => {
    const d = isoDate(new Date(s.startsAt));
    (a[d] ??= []).push(s);
    return a;
  }, {});
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Book a meeting"
      footer={
        <Button disabled={!slotId} loading={book.isPending} onClick={() => book.mutate()}>
          Request meeting
        </Button>
      }
    >
      <div className="space-y-4">
        {(kids.data?.length ?? 0) > 1 && (
          <Field label="Child">
            <Select value={sid} onChange={(e) => setStudentId(e.target.value)} options={(kids.data ?? []).map((k) => ({ value: k.id, label: `${k.firstName} ${k.lastName}` }))} />
          </Field>
        )}
        <Field label="Teacher">
          <Select value={teacherId} onChange={(e) => (setTeacherId(e.target.value), setSlotId(''))} placeholder="Choose a teacher" options={(teachers.data ?? []).map((t) => ({ value: t.id, label: `${t.fullName} — ${t.roles.join(', ')}` }))} />
        </Field>
        {teacherId && (
          <Field label="Available times">
            {slots.isLoading ? (
              <Loading />
            ) : Object.keys(byDay).length ? (
              <div className="space-y-3">
                {Object.entries(byDay).map(([d, list]) => (
                  <div key={d}>
                    <p className="mb-1.5 text-xs font-medium text-slate-500">{fmtDate(d)}</p>
                    <div className="flex flex-wrap gap-2">
                      {list.map((s) => (
                        <button key={s.id} type="button" onClick={() => setSlotId(s.id)} className={clsx('rounded-lg border px-3 py-1.5 text-sm tabular-nums', slotId === s.id ? 'border-brand bg-brand text-white' : 'border-slate-300 hover:border-brand')}>
                          {format(new Date(s.startsAt), 'h:mm a')}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">This teacher has no open slots right now.</p>
            )}
          </Field>
        )}
        <Field label="What would you like to discuss?">
          <Textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ScheduleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const teachers = useTeachers();
  const [search, setSearch] = useState('');
  const students = useQuery({ queryKey: ['students', 'meet', search], queryFn: () => get<any[]>('/students', { search, pageSize: 8 }), enabled: open && search.length >= 2 });
  const [f, setF] = useState({ studentId: '', studentLabel: '', teacherId: '', startsAt: '', durationMin: '15', location: '', agenda: '' });
  const save = useAction(() => post('/meetings', { ...f, teacherId: f.teacherId || undefined, durationMin: Number(f.durationMin), startsAt: f.startsAt }), {
    success: 'Meeting scheduled; parents notified',
    invalidate: [['meetings']],
    onSuccess: onClose,
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule a meeting"
      footer={
        <Button disabled={!f.studentId || !f.startsAt} loading={save.isPending} onClick={() => save.mutate()}>
          Schedule
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Student" className="sm:col-span-2">
          {f.studentId ? (
            <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm">
              {f.studentLabel}
              <button className="text-xs text-brand-700" onClick={() => setF({ ...f, studentId: '' })}>
                Change
              </button>
            </div>
          ) : (
            <>
              <Input placeholder="Search student…" value={search} onChange={(e) => setSearch(e.target.value)} />
              {students.data && (
                <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-slate-200">
                  {students.data.map((s) => (
                    <li key={s.id}>
                      <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => setF({ ...f, studentId: s.id, studentLabel: `${s.firstName} ${s.lastName} · ${s.className ?? ''} ${s.sectionName ?? ''}` })}>
                        {s.firstName} {s.lastName} <span className="text-slate-500">· {s.admissionNo}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Field>
        {user?.role.scope === 'school' && (
          <Field label="Teacher" className="sm:col-span-2">
            <Select value={f.teacherId} onChange={(e) => setF({ ...f, teacherId: e.target.value })} placeholder="Me" options={(teachers.data ?? []).map((t) => ({ value: t.id, label: t.fullName }))} />
          </Field>
        )}
        <Field label="Date & time">
          <Input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />
        </Field>
        <Field label="Duration (min)">
          <Input type="number" value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: e.target.value })} />
        </Field>
        <Field label="Location" className="sm:col-span-2">
          <Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
        </Field>
        <Field label="Agenda" className="sm:col-span-2">
          <Textarea value={f.agenda} onChange={(e) => setF({ ...f, agenda: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function Slots() {
  const from = today();
  const to = isoDate(new Date(Date.now() + 60 * 86400_000));
  const q = useQuery({ queryKey: ['slots', 'mine'], queryFn: () => get<any[]>('/meetings/slots', { from, to }) });
  const [f, setF] = useState({ date: isoDate(new Date(Date.now() + 86400_000)), from: '15:00', to: '16:00', durationMin: '15', location: '' });
  const add = useAction(() => post('/meetings/slots', { ...f, durationMin: Number(f.durationMin) }), { success: (r: any) => `${r.length} slots published`, invalidate: [['slots']] });
  const remove = useAction((id: string) => del(`/meetings/slots/${id}`), { invalidate: [['slots']] });
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Publish availability" subtitle="Parents can book these slots for their child.">
        <div className="space-y-3">
          <Field label="Date">
            <Input type="date" min={today()} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <Input type="time" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
            </Field>
            <Field label="To">
              <Input type="time" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
            </Field>
          </div>
          <Field label="Slot length">
            <Select value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: e.target.value })} options={['10', '15', '20', '30'].map((v) => ({ value: v, label: `${v} minutes` }))} />
          </Field>
          <Field label="Location">
            <Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="Room 204" />
          </Field>
          <Button className="w-full" icon={<Clock className="size-4" />} loading={add.isPending} onClick={() => add.mutate()}>
            Create slots
          </Button>
        </div>
      </Card>
      <Card title="Upcoming slots" padded={false} className="xl:col-span-2">
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          rowKey={(r: any) => r.id}
          columns={[
            { key: 'startsAt', header: 'Time', render: (r: any) => fmtDateTime(r.startsAt) },
            { key: 'location', header: 'Location' },
            { key: 'isBooked', header: 'Status', render: (r: any) => (r.isBooked ? <Badge tone="green">Booked</Badge> : <Badge>Open</Badge>) },
            { key: 'x', header: '', align: 'right', render: (r: any) => !r.isBooked && <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.id)}><Trash2 className="size-4" /></Button> },
          ]}
          empty={<EmptyState title="No slots published" />}
        />
      </Card>
    </div>
  );
}
