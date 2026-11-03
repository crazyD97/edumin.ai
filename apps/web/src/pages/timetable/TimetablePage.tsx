import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Plus, Printer, Save, Trash2 } from 'lucide-react';
import { DAYS } from '@edumin/shared';
import { ApiError, del, get, openPdf, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useSections, useSubjects, useTeachers, toOptions } from '@/lib/hooks';
import { fmtTime, titleCase, today } from '@/lib/format';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, NoSections, PageHeader, Select, Tabs, clsx, confirm } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { FormModal } from '@/components/FormModal';

type Tab = 'class' | 'teacher' | 'substitutions' | 'periods';

interface Entry {
  dayOfWeek: number;
  periodId: string;
  subjectId: string | null;
  teacherId: string | null;
  room: string | null;
  subjectName?: string | null;
  teacherName?: string | null;
  sectionLabel?: string;
}

export function TimetablePage() {
  const { can, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const staff = user?.role.scope !== 'own';
  const tabs: { value: Tab; label: string }[] = staff
    ? [
        { value: 'class', label: 'Class timetable' },
        { value: 'teacher', label: 'Teacher timetable' },
        { value: 'substitutions', label: 'Substitutions' },
        ...(can('timetable.edit') ? [{ value: 'periods' as Tab, label: 'Periods' }] : []),
      ]
    : [{ value: 'class', label: 'Weekly timetable' }];
  const tab = (params.get('tab') as Tab) ?? (user?.role.scope === 'assigned' ? 'teacher' : 'class');
  return (
    <>
      <PageHeader title="Timetable" description={staff ? 'Weekly schedules, teacher allocation and substitutions.' : 'Your weekly class schedule.'} />
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t })} />}
      {tab === 'class' && <ClassTimetable />}
      {tab === 'teacher' && <TeacherTimetable />}
      {tab === 'substitutions' && <Substitutions />}
      {tab === 'periods' && <Periods />}
    </>
  );
}

function Grid({ periods, entries, render, onCell, days = DAYS }: { periods: any[]; entries: Entry[]; render: (e: Entry) => React.ReactNode; onCell?: (day: number, period: any) => void; days?: readonly { value: number; short: string; label: string }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-1 text-sm">
        <thead>
          <tr>
            <th className="w-28 px-2 py-2 text-left text-xs font-medium text-slate-500">Period</th>
            {days.map((d) => (
              <th key={d.value} className="min-w-28 px-2 py-2 text-left text-xs font-medium text-slate-500">
                <span className="hidden sm:inline">{d.label}</span>
                <span className="sm:hidden">{d.short}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => (
            <tr key={p.id}>
              <td className="px-2 py-1 align-top">
                <p className="text-xs font-medium text-slate-700">{p.name}</p>
                <p className="text-[11px] text-slate-400 tabular-nums">
                  {fmtTime(p.startTime)} – {fmtTime(p.endTime)}
                </p>
              </td>
              {p.isBreak ? (
                <td colSpan={days.length} className="rounded-md bg-slate-100 py-1.5 text-center text-xs tracking-widest text-slate-400 uppercase">
                  Break
                </td>
              ) : (
                days.map((d) => {
                  const e = entries.find((x) => x.dayOfWeek === d.value && x.periodId === p.id);
                  return (
                    <td key={d.value} className="p-0 align-top">
                      <button
                        type="button"
                        disabled={!onCell}
                        onClick={() => onCell?.(d.value, p)}
                        className={clsx(
                          'h-full min-h-14 w-full rounded-lg border p-2 text-left transition',
                          e ? 'border-brand-200 bg-brand-50' : 'border-dashed border-slate-200 bg-white',
                          onCell && 'hover:border-brand hover:shadow-sm',
                        )}
                      >
                        {e ? render(e) : onCell ? <span className="text-xs text-slate-300">+ Add</span> : null}
                      </button>
                    </td>
                  );
                })
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClassTimetable() {
  const { can, user } = useAuth();
  const sections = useSections();
  const subjects = useSubjects();
  const teachers = useTeachers();
  const [sectionId, setSectionId] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [cell, setCell] = useState<{ day: number; period: any } | null>(null);
  const [clashes, setClashes] = useState<any[]>([]);
  useEffect(() => {
    if (!sectionId && sections.data?.length) setSectionId(sections.data[0].id);
  }, [sections.data, sectionId]);
  const q = useQuery({ queryKey: ['timetable', sectionId], queryFn: () => get<any>(`/timetable/sections/${sectionId}`), enabled: !!sectionId });
  useEffect(() => {
    if (q.data) {
      setEntries(q.data.entries);
      setDirty(false);
      setClashes([]);
    }
  }, [q.data]);
  const editable = can('timetable.edit') && user?.role.scope === 'school';
  const save = useAction(() => put(`/timetable/sections/${sectionId}`, { entries: entries.map(({ dayOfWeek, periodId, subjectId, teacherId, room }) => ({ dayOfWeek, periodId, subjectId, teacherId, room })) }), {
    success: 'Timetable saved',
    invalidate: [['timetable']],
    onError: (e: ApiError) => {
      if (e.code === 'CONFLICT' && Array.isArray(e.details)) setClashes(e.details);
    },
  });
  const current = cell ? entries.find((e) => e.dayOfWeek === cell.day && e.periodId === cell.period.id) : undefined;
  const [draft, setDraft] = useState({ subjectId: '', teacherId: '', room: '' });
  useEffect(() => {
    if (cell) setDraft({ subjectId: current?.subjectId ?? '', teacherId: current?.teacherId ?? '', room: current?.room ?? '' });
  }, [cell, current]);
  const applyCell = (clear = false) => {
    if (!cell) return;
    const rest = entries.filter((e) => !(e.dayOfWeek === cell.day && e.periodId === cell.period.id));
    const next = clear
      ? rest
      : [...rest, { dayOfWeek: cell.day, periodId: cell.period.id, subjectId: draft.subjectId || null, teacherId: draft.teacherId || null, room: draft.room || null, subjectName: subjects.data?.find((s) => s.id === draft.subjectId)?.name, teacherName: teachers.data?.find((t) => t.id === draft.teacherId)?.fullName }];
    setEntries(next);
    setDirty(true);
    setCell(null);
    // Live clash check
    post<any[]>(`/timetable/sections/${sectionId}/check`, { entries: next.map(({ dayOfWeek, periodId, subjectId, teacherId, room }) => ({ dayOfWeek, periodId, subjectId, teacherId, room })) }).then(setClashes).catch(() => {});
  };
  const isClash = (e: Entry) => clashes.some((c) => c.dayOfWeek === e.dayOfWeek && c.periodId === e.periodId);

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
        {(sections.data?.length ?? 0) > 1 && <Select className="w-52" value={sectionId} onChange={(e) => setSectionId(e.target.value)} options={toOptions(sections.data, (s) => s.label)} />}
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" icon={<Printer className="size-4" />} onClick={() => openPdf(`/timetable/sections/${sectionId}/pdf`)} disabled={!sectionId}>
            Print
          </Button>
          {editable && (
            <Button icon={<Save className="size-4" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          )}
        </div>
      </div>
      {clashes.length > 0 && (
        <div className="m-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="mb-1 flex items-center gap-1.5 font-medium">
            <AlertTriangle className="size-4" /> Teacher clashes
          </p>
          <ul className="list-disc pl-5 text-xs">
            {clashes.map((c, i) => (
              <li key={i}>
                {c.teacherName} is already teaching {c.otherSection} on {DAYS.find((d) => d.value === c.dayOfWeek)?.label} ({q.data?.periods.find((p: any) => p.id === c.periodId)?.name})
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="p-3">
        {sections.data && !sections.data.length ? (
          <NoSections />
        ) : q.isLoading || !q.data ? (
          <Loading />
        ) : (
          <Grid
            periods={q.data.periods}
            entries={entries}
            onCell={editable ? (day, period) => setCell({ day, period }) : undefined}
            render={(e) => (
              <>
                <p className={clsx('truncate text-xs font-semibold', isClash(e) ? 'text-red-700' : 'text-slate-800')}>{e.subjectName ?? '—'}</p>
                <p className="truncate text-[11px] text-slate-500">{e.teacherName ?? 'No teacher'}</p>
              </>
            )}
          />
        )}
      </div>
      <Modal
        open={!!cell}
        onClose={() => setCell(null)}
        size="sm"
        title={cell ? `${DAYS.find((d) => d.value === cell.day)?.label} · ${cell.period.name}` : ''}
        footer={
          <>
            {current && (
              <Button variant="ghost" className="mr-auto" icon={<Trash2 className="size-4" />} onClick={() => applyCell(true)}>
                Clear
              </Button>
            )}
            <Button onClick={() => applyCell()}>Apply</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Subject">
            <Select value={draft.subjectId} onChange={(e) => setDraft({ ...draft, subjectId: e.target.value })} placeholder="—" options={toOptions(subjects.data, (s) => s.name)} />
          </Field>
          <Field label="Teacher">
            <Select value={draft.teacherId} onChange={(e) => setDraft({ ...draft, teacherId: e.target.value })} placeholder="—" options={toOptions(teachers.data, (t) => t.fullName)} />
          </Field>
          <Field label="Room">
            <Input value={draft.room} onChange={(e) => setDraft({ ...draft, room: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </Card>
  );
}

function TeacherTimetable() {
  const { user } = useAuth();
  const teachers = useTeachers();
  const [teacherId, setTeacherId] = useState(user?.role.scope === 'school' ? '' : (user?.id ?? ''));
  useEffect(() => {
    if (!teacherId && teachers.data?.length) setTeacherId(teachers.data[0].id);
  }, [teachers.data, teacherId]);
  const q = useQuery({ queryKey: ['timetable-teacher', teacherId], queryFn: () => get<any>(`/timetable/teachers/${teacherId}`), enabled: !!teacherId });
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
        {user?.role.scope === 'school' && <Select className="w-56" value={teacherId} onChange={(e) => setTeacherId(e.target.value)} options={toOptions(teachers.data, (t) => t.fullName)} />}
        {q.data && <span className="text-sm text-slate-500">{q.data.entries.length} periods per week</span>}
        <Button variant="secondary" className="ml-auto" icon={<Printer className="size-4" />} disabled={!teacherId} onClick={() => openPdf(`/timetable/teachers/${teacherId}/pdf`)}>
          Print
        </Button>
      </div>
      <div className="p-3">
        {q.isLoading || !q.data ? (
          <Loading />
        ) : (
          <Grid
            periods={q.data.periods}
            entries={q.data.entries}
            render={(e) => (
              <>
                <p className="truncate text-xs font-semibold text-slate-800">{e.sectionLabel}</p>
                <p className="truncate text-[11px] text-slate-500">{e.subjectName}</p>
              </>
            )}
          />
        )}
      </div>
    </Card>
  );
}

function Substitutions() {
  const { can } = useAuth();
  const teachers = useTeachers();
  const [date, setDate] = useState(today());
  const [absent, setAbsent] = useState('');
  const [assign, setAssign] = useState<any>(null);
  const [sub, setSub] = useState('');
  const list = useQuery({ queryKey: ['substitutions', date], queryFn: () => get<any[]>('/substitutions', { date }) });
  const dow = new Date(date + 'T00:00:00').getDay() || 7;
  const absentTT = useQuery({ queryKey: ['timetable-teacher', absent], queryFn: () => get<any>(`/timetable/teachers/${absent}`), enabled: !!absent });
  const free = useQuery({ queryKey: ['free-teachers', assign?.id, date], queryFn: () => get<any[]>('/substitutions/free-teachers', { entryId: assign.id, date }), enabled: !!assign });
  const create = useAction(() => post('/substitutions', { entryId: assign.id, date, substituteTeacherId: sub }), {
    success: 'Substitute assigned and notified',
    invalidate: [['substitutions']],
    onSuccess: () => {
      setAssign(null);
      setSub('');
    },
  });
  const remove = useAction((id: string) => del(`/substitutions/${id}`), { invalidate: [['substitutions']] });
  const slots = (absentTT.data?.entries ?? []).filter((e: any) => e.dayOfWeek === dow).sort((a: any, b: any) => (absentTT.data.periods.findIndex((p: any) => p.id === a.periodId) - absentTT.data.periods.findIndex((p: any) => p.id === b.periodId)));
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card title="Arrange cover" subtitle="Pick the absent teacher; assign a free teacher to each of their periods.">
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Absent teacher">
            <Select value={absent} onChange={(e) => setAbsent(e.target.value)} placeholder="Choose" options={toOptions(teachers.data, (t) => t.fullName)} />
          </Field>
        </div>
        {absent &&
          (slots.length ? (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {slots.map((e: any) => {
                const covered = list.data?.find((s) => s.entryId === e.id);
                const p = absentTT.data.periods.find((x: any) => x.id === e.periodId);
                return (
                  <li key={e.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div>
                      <p className="text-sm font-medium">
                        {p?.name} · {e.sectionLabel}
                      </p>
                      <p className="text-xs text-slate-500">{e.subjectName}</p>
                    </div>
                    {covered ? (
                      <Badge tone="green">{covered.substituteName}</Badge>
                    ) : (
                      can('timetable.edit') && (
                        <Button size="sm" variant="subtle" onClick={() => setAssign(e)}>
                          Assign
                        </Button>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title="No periods on this day" />
          ))}
      </Card>
      <Card title="Substitutions on this date" padded={false}>
        <DataTable
          rows={list.data}
          loading={list.isLoading}
          rowKey={(r: any) => r.id}
          columns={[
            { key: 'sectionLabel', header: 'Class', render: (r: any) => <span className="font-medium">{r.sectionLabel}</span> },
            { key: 'subjectName', header: 'Subject' },
            { key: 'teacherName', header: 'Absent', render: (r: any) => r.teacherName },
            { key: 'substituteName', header: 'Covered by', render: (r: any) => <Badge tone="violet">{r.substituteName}</Badge> },
            { key: 'x', header: '', align: 'right', render: (r: any) => can('timetable.edit') && <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.id)}><Trash2 className="size-4" /></Button> },
          ]}
          empty={<EmptyState title="No substitutions" />}
        />
      </Card>
      <Modal
        open={!!assign}
        onClose={() => setAssign(null)}
        size="sm"
        title="Assign substitute"
        description={assign ? `${assign.sectionLabel} · ${assign.subjectName}` : ''}
        footer={
          <Button disabled={!sub} loading={create.isPending} onClick={() => create.mutate()}>
            Assign
          </Button>
        }
      >
        {free.isLoading ? <Loading /> : <Select value={sub} onChange={(e) => setSub(e.target.value)} placeholder={free.data?.length ? 'Choose a free teacher' : 'No teachers free in this period'} options={toOptions(free.data, (t: any) => t.fullName)} />}
      </Modal>
    </div>
  );
}

function Periods() {
  const q = useQuery({ queryKey: ['periods'], queryFn: () => get<any[]>('/periods') });
  const [editing, setEditing] = useState<any>(null);
  const remove = useAction((id: string) => del(`/periods/${id}`), { success: 'Period deleted', invalidate: [['periods'], ['timetable']] });
  return (
    <Card padded={false}>
      <div className="flex justify-end border-b border-slate-100 p-3">
        <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ sortOrder: (q.data?.length ?? 0) + 1, isBreak: false })}>
          Add period
        </Button>
      </div>
      <DataTable
        rows={q.data}
        loading={q.isLoading}
        rowKey={(r: any) => r.id}
        columns={[
          { key: 'sortOrder', header: '#', align: 'right' },
          { key: 'name', header: 'Name', render: (r: any) => <span className="font-medium">{r.name}</span> },
          { key: 'time', header: 'Time', render: (r: any) => `${fmtTime(r.startTime)} – ${fmtTime(r.endTime)}` },
          { key: 'isBreak', header: 'Type', render: (r: any) => (r.isBreak ? <Badge>Break</Badge> : titleCase('teaching')) },
          {
            key: 'a',
            header: '',
            align: 'right',
            render: (r: any) => (
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditing({ ...r, startTime: r.startTime.slice(0, 5), endTime: r.endTime.slice(0, 5) })}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => (await confirm({ title: `Delete ${r.name}?`, message: 'Timetable entries in this period are removed.', danger: true })) && remove.mutate(r.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ),
          },
        ]}
      />
      <FormModal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit period' : 'Add period'}
        initial={editing ?? {}}
        fields={[
          { name: 'name', label: 'Name', required: true, span: 1 },
          { name: 'sortOrder', label: 'Order', type: 'number', required: true, span: 1 },
          { name: 'startTime', label: 'Start', type: 'time', required: true, span: 1 },
          { name: 'endTime', label: 'End', type: 'time', required: true, span: 1 },
          { name: 'isBreak', label: 'This is a break (no teaching)', type: 'checkbox' },
        ]}
        submit={(v) => {
          const body = { ...v, sortOrder: Number(v.sortOrder) };
          return editing?.id ? put(`/periods/${editing.id}`, body) : post('/periods', body);
        }}
        success="Period saved"
        invalidate={[['periods'], ['timetable']]}
      />
    </Card>
  );
}
