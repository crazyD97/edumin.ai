import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, Download, Lock, Megaphone, Save, Send, Unlock } from 'lucide-react';
import { get, openPdf, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useClasses, useSections, useSubjects, toOptions } from '@/lib/hooks';
import { fmtDate, fmtTime, pct } from '@/lib/format';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Input, Loading, Modal, NoSections, PageHeader, Select, Stat, StatusBadge, Tabs, confirm, clsx } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { BarsChart } from '@/components/charts';

type Tab = 'schedule' | 'marks' | 'results';

export function ExamDetailPage() {
  const { id } = useParams();
  const { can, user } = useAuth();
  const family = user?.role.scope === 'own';
  const admin = user?.role.scope === 'school';
  const [params, setParams] = useSearchParams();
  const exam = useQuery({ queryKey: ['exam', id], queryFn: () => get<any>(`/exams/${id}`) });
  const tab = (params.get('tab') as Tab) ?? (family ? 'results' : admin && exam.data?.status === 'draft' ? 'schedule' : 'marks');
  const setStatus = useAction((status: string) => put(`/exams/${id}`, { name: exam.data.name, term: exam.data.term, gradingScaleId: exam.data.gradingScaleId, startDate: exam.data.startDate, endDate: exam.data.endDate, description: exam.data.description, status }), {
    success: 'Exam scheduled and announced to students & parents',
    invalidate: [['exam'], ['exams']],
  });
  const publish = useAction((p: boolean) => post<any>(`/exams/${id}/publish`, { publish: p }), {
    success: (r: any) => (r.status === 'published' ? `Results published${r.incomplete ? ` (${r.incomplete} incomplete)` : ''}` : 'Results unpublished — marks can be edited again'),
    invalidate: [['exam'], ['exams'], ['results']],
  });
  if (exam.isLoading) return <Loading />;
  if (exam.error) return <ErrorState error={exam.error} />;
  const e = exam.data;
  const tabs: { value: Tab; label: string }[] = family
    ? [
        { value: 'results', label: 'Result' },
        { value: 'schedule', label: 'Schedule' },
      ]
    : [
        { value: 'schedule', label: 'Schedule' },
        { value: 'marks', label: 'Marks entry' },
        { value: 'results', label: 'Results' },
      ];
  return (
    <>
      <PageHeader
        back={{ to: '/exams', label: family ? 'Results' : 'Examinations' }}
        title={
          <span className="flex items-center gap-3">
            {e.name} <StatusBadge status={e.status} label={e.status === 'published' ? 'Results published' : undefined} />
          </span>
        }
        description={[e.term, e.startDate && `${fmtDate(e.startDate)} – ${fmtDate(e.endDate)}`].filter(Boolean).join(' · ')}
        actions={
          admin && (
            <>
              {e.status === 'draft' && can('exams.edit') && (
                <Button variant="secondary" icon={<Megaphone className="size-4" />} loading={setStatus.isPending} onClick={() => setStatus.mutate('scheduled')}>
                  Publish schedule
                </Button>
              )}
              {can('exams.approve') &&
                (e.status === 'published' ? (
                  <Button variant="secondary" icon={<Unlock className="size-4" />} onClick={async () => (await confirm({ title: 'Unpublish results?', message: 'Students and parents will no longer see them, and marks become editable.' })) && publish.mutate(false)}>
                    Unpublish
                  </Button>
                ) : (
                  e.status !== 'draft' && (
                    <Button icon={<Lock className="size-4" />} onClick={async () => (await confirm({ title: 'Approve & publish results?', message: 'Marks are locked, and students and parents are notified.' })) && publish.mutate(true)}>
                      Approve & publish results
                    </Button>
                  )
                ))}
            </>
          )
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t })} />
      {tab === 'schedule' && <Schedule exam={e} editable={admin && can('exams.edit') && e.status !== 'published'} />}
      {tab === 'marks' && <MarksEntry exam={e} />}
      {tab === 'results' && (family ? <FamilyResult exam={e} /> : <Results exam={e} />)}
    </>
  );
}

function Schedule({ exam, editable }: { exam: any; editable: boolean }) {
  const classes = useClasses();
  const subjects = useSubjects();
  const papers = useQuery({ queryKey: ['papers', exam.id], queryFn: () => get<any[]>(`/exams/${exam.id}/papers`) });
  const [classId, setClassId] = useState('');
  const [rows, setRows] = useState<Record<string, any>>({});
  useEffect(() => {
    if (!classId && classes.data?.length && editable) setClassId(classes.data[0].id);
  }, [classes.data, classId, editable]);
  useEffect(() => {
    if (!papers.data || !subjects.data) return;
    const mine = papers.data.filter((p) => p.classId === classId);
    setRows(
      Object.fromEntries(
        subjects.data.map((s) => {
          const p = mine.find((x) => x.subjectId === s.id);
          return [s.id, p ? { on: true, date: p.date ?? '', startTime: p.startTime?.slice(0, 5) ?? '', endTime: p.endTime?.slice(0, 5) ?? '', maxMarks: p.maxMarks, passMarks: p.passMarks, room: p.room ?? '' } : { on: false, date: '', startTime: '09:00', endTime: '12:00', maxMarks: 100, passMarks: 33, room: '' }];
        }),
      ),
    );
  }, [papers.data, subjects.data, classId]);
  const save = useAction(
    () =>
      put(`/exams/${exam.id}/papers`, {
        classId,
        items: Object.entries(rows)
          .filter(([, r]) => r.on)
          .map(([subjectId, r]) => ({ subjectId, date: r.date, startTime: r.startTime, endTime: r.endTime, maxMarks: Number(r.maxMarks), passMarks: Number(r.passMarks), room: r.room })),
      }),
    { success: 'Schedule saved', invalidate: [['papers']] },
  );
  if (papers.isLoading) return <Loading />;

  if (!editable) {
    return (
      <Card padded={false}>
        <DataTable
          rows={papers.data}
          rowKey={(p: any) => p.id}
          columns={[
            { key: 'className', header: 'Class' },
            { key: 'subjectName', header: 'Subject', render: (p: any) => <span className="font-medium text-slate-900">{p.subjectName}</span> },
            { key: 'date', header: 'Date', render: (p: any) => fmtDate(p.date) },
            { key: 'time', header: 'Time', render: (p: any) => (p.startTime ? `${fmtTime(p.startTime)} – ${fmtTime(p.endTime)}` : '—') },
            { key: 'maxMarks', header: 'Max', align: 'right' },
            { key: 'passMarks', header: 'Pass', align: 'right' },
            { key: 'room', header: 'Room', hideOnMobile: true },
          ]}
          empty={<EmptyState title="Schedule not published yet" />}
        />
      </Card>
    );
  }
  const set = (sid: string, patch: any) => setRows((p) => ({ ...p, [sid]: { ...p[sid], ...patch } }));
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
        <Select className="w-48" value={classId} onChange={(e) => setClassId(e.target.value)} options={toOptions(classes.data, (c) => c.name)} />
        <span className="text-sm text-slate-500">{papers.data?.filter((p) => p.classId === classId).length ?? 0} papers scheduled</span>
        <Button className="ml-auto" icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate()}>
          Save schedule
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-slate-50/70">
            <tr>
              <th className="th">Subject</th>
              <th className="th">Date</th>
              <th className="th">Start</th>
              <th className="th">End</th>
              <th className="th">Max marks</th>
              <th className="th">Pass marks</th>
              <th className="th">Room</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {subjects.data?.map((s) => {
              const r = rows[s.id];
              if (!r) return null;
              return (
                <tr key={s.id} className={clsx(!r.on && 'opacity-60')}>
                  <td className="td">
                    <Checkbox checked={r.on} onChange={(on) => set(s.id, { on })} label={<span className="font-medium">{s.name}</span>} />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input type="date" disabled={!r.on} value={r.date} onChange={(e) => set(s.id, { date: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input type="time" disabled={!r.on} value={r.startTime} onChange={(e) => set(s.id, { startTime: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input type="time" disabled={!r.on} value={r.endTime} onChange={(e) => set(s.id, { endTime: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input type="number" className="w-24" disabled={!r.on} value={r.maxMarks} onChange={(e) => set(s.id, { maxMarks: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input type="number" className="w-24" disabled={!r.on} value={r.passMarks} onChange={(e) => set(s.id, { passMarks: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input className="w-24" disabled={!r.on} value={r.room} onChange={(e) => set(s.id, { room: e.target.value })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function MarksEntry({ exam }: { exam: any }) {
  const sections = useSections(exam.academicYearId);
  const papers = useQuery({ queryKey: ['papers', exam.id], queryFn: () => get<any[]>(`/exams/${exam.id}/papers`) });
  const [sectionId, setSectionId] = useState('');
  const [paperId, setPaperId] = useState('');
  const section = sections.data?.find((s) => s.id === sectionId);
  const classPapers = useMemo(() => papers.data?.filter((p) => p.classId === section?.classId) ?? [], [papers.data, section]);
  useEffect(() => {
    if (!sectionId && sections.data?.length) setSectionId(sections.data[0].id);
  }, [sections.data, sectionId]);
  useEffect(() => {
    if (!classPapers.find((p) => p.id === paperId)) setPaperId(classPapers[0]?.id ?? '');
  }, [classPapers, paperId]);
  const sheet = useQuery({ queryKey: ['marks', paperId, sectionId], queryFn: () => get<any>(`/exam-papers/${paperId}/marks`, { sectionId }), enabled: !!paperId && !!sectionId });
  const [entries, setEntries] = useState<Record<string, { marks: string; absent: boolean }>>({});
  useEffect(() => {
    if (sheet.data) setEntries(Object.fromEntries(sheet.data.students.map((s: any) => [s.studentId, { marks: s.marksObtained ?? '', absent: s.isAbsent }])));
  }, [sheet.data]);
  const save = useAction(
    () =>
      put(`/exam-papers/${paperId}/marks`, {
        sectionId,
        entries: Object.entries(entries)
          .filter(([, e]) => e.absent || e.marks !== '')
          .map(([studentId, e]) => ({ studentId, isAbsent: e.absent, marksObtained: e.absent ? null : Number(e.marks) })),
      }),
    { success: 'Marks saved', invalidate: [['marks'], ['papers'], ['exam']] },
  );
  const max = sheet.data?.paper.maxMarks ?? 100;
  const canEdit = sheet.data?.canEdit;
  const invalid = Object.values(entries).some((e) => !e.absent && e.marks !== '' && (Number(e.marks) > max || Number(e.marks) < 0));

  if (sections.data && !sections.data.length) return <Card><NoSections /></Card>;
  if (exam.status === 'draft') return <Card><EmptyState title="Publish the schedule first" description="Marks entry opens once the exam is scheduled." /></Card>;
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
        <Select className="w-48" value={sectionId} onChange={(e) => setSectionId(e.target.value)} options={toOptions(sections.data, (s) => s.label)} />
        <Select className="w-56" value={paperId} onChange={(e) => setPaperId(e.target.value)} placeholder="No papers for this class" options={classPapers.map((p) => ({ value: p.id, label: `${p.subjectName} (max ${p.maxMarks})` }))} />
        {sheet.data && !canEdit && (
          <Badge tone="gray">
            <Lock className="size-3" /> {exam.status === 'published' ? 'Results published — locked' : 'View only'}
          </Badge>
        )}
        {canEdit && (
          <Button className="ml-auto" icon={<Save className="size-4" />} disabled={invalid} loading={save.isPending} onClick={() => save.mutate()}>
            Save marks
          </Button>
        )}
      </div>
      {!paperId ? (
        <EmptyState title="No paper scheduled" description="Add this class to the exam schedule first." />
      ) : sheet.isLoading ? (
        <Loading />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-slate-50/70">
              <tr>
                <th className="th w-14">Roll</th>
                <th className="th">Student</th>
                <th className="th w-40">Marks / {max}</th>
                <th className="th">Absent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sheet.data?.students.map((s: any) => {
                const e = entries[s.studentId] ?? { marks: '', absent: false };
                const bad = !e.absent && e.marks !== '' && (Number(e.marks) > max || Number(e.marks) < 0);
                const fail = !e.absent && e.marks !== '' && Number(e.marks) < sheet.data.paper.passMarks;
                return (
                  <tr key={s.studentId}>
                    <td className="td text-slate-400 tabular-nums">{s.rollNo}</td>
                    <td className="td font-medium text-slate-900">{s.name}</td>
                    <td className="px-4 py-1.5">
                      <Input
                        type="number"
                        inputMode="decimal"
                        disabled={!canEdit || e.absent}
                        value={e.absent ? '' : e.marks}
                        invalid={bad}
                        className={clsx('w-28 tabular-nums', fail && 'text-red-600')}
                        onChange={(ev) => setEntries((p) => ({ ...p, [s.studentId]: { ...e, marks: ev.target.value } }))}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter') (ev.currentTarget.closest('tr')?.nextElementSibling?.querySelector('input[type=number]') as HTMLInputElement | null)?.focus();
                        }}
                      />
                    </td>
                    <td className="td">
                      <Checkbox disabled={!canEdit} checked={e.absent} onChange={(absent) => setEntries((p) => ({ ...p, [s.studentId]: { ...e, absent } }))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Results({ exam }: { exam: any }) {
  const { can } = useAuth();
  const sections = useSections(exam.academicYearId);
  const [sectionId, setSectionId] = useState('');
  useEffect(() => {
    if (!sectionId && sections.data?.length) setSectionId(sections.data[0].id);
  }, [sections.data, sectionId]);
  const q = useQuery({ queryKey: ['results', exam.id, sectionId], queryFn: () => get<any>(`/exams/${exam.id}/results`, { sectionId }), enabled: !!sectionId });
  const subjects: { id: string; name: string }[] = useMemo(() => {
    const m = new Map<string, string>();
    q.data?.results.forEach((r: any) => r.subjects.forEach((s: any) => m.set(s.subjectId, s.subjectName)));
    return [...m.entries()].map(([id, name]) => ({ id, name }));
  }, [q.data]);
  const sm = q.data?.summary;
  const [sending, setSending] = useState(false);
  const [channels, setChannels] = useState<string[]>(['whatsapp', 'email']);
  const send = useAction(() => post<any>('/messaging/report-cards', { examId: exam.id, sectionId, channels }), {
    success: (r: any) => (r.queued ? `Report cards queued for ${r.queued} message(s)${r.credits ? ` · ${r.credits} credits` : ''}` : (r.reason ?? 'Nothing was sent')),
    onSuccess: () => setSending(false),
  });
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-48" value={sectionId} onChange={(e) => setSectionId(e.target.value)} options={toOptions(sections.data, (s) => s.label)} />
        <Button variant="secondary" className="ml-auto" icon={<Download className="size-4" />} disabled={!q.data?.results.length} onClick={() => openPdf(`/exams/${exam.id}/report-cards`, { sectionId })}>
          Report cards (PDF)
        </Button>
        {exam.status === 'published' && can('messaging.create') && (
          <Button variant="secondary" icon={<Send className="size-4" />} disabled={!q.data?.results.length} onClick={() => setSending(true)}>
            Send to parents
          </Button>
        )}
      </div>
      <Modal
        open={sending}
        onClose={() => setSending(false)}
        size="sm"
        title="Send report cards to parents"
        description="Each student's primary guardian gets their own report card PDF."
        footer={
          <Button icon={<Send className="size-4" />} disabled={!channels.length} loading={send.isPending} onClick={() => send.mutate()}>
            Send
          </Button>
        }
      >
        <div className="space-y-3">
          {[
            ['whatsapp', 'WhatsApp (1 credit each)'],
            ['email', 'Email (free)'],
            ['sms', 'SMS — result summary only, no PDF (1 credit each)'],
          ].map(([c, label]) => (
            <Checkbox key={c} checked={channels.includes(c)} onChange={(on) => setChannels((p) => (on ? [...p, c] : p.filter((x) => x !== c)))} label={label} />
          ))}
        </div>
      </Modal>
      {q.isLoading ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Appeared" value={`${sm?.appeared ?? 0} / ${sm?.students ?? 0}`} />
            <Stat label="Pass rate" value={pct(sm?.passRate)} tone="green" />
            <Stat label="Class average" value={pct(sm?.average)} tone="blue" />
            <Stat label="Highest" value={pct(sm?.highest)} tone="violet" />
          </div>
          <Card title="Subject performance">
            {q.data?.subjectStats.length ? <BarsChart data={q.data.subjectStats} xKey="subjectName" series={[{ key: 'average', label: 'Average %' }, { key: 'passRate', label: 'Pass rate %' }]} format={(v) => `${v}%`} /> : <EmptyState title="No marks entered yet" />}
          </Card>
          <Card padded={false} title="Merit list">
            <DataTable
              rows={[...(q.data?.results ?? [])].sort((a: any, b: any) => (a.sectionRank ?? 999) - (b.sectionRank ?? 999))}
              rowKey={(r: any) => r.studentId}
              dense
              columns={[
                { key: 'sectionRank', header: 'Rank', align: 'right', render: (r: any) => r.sectionRank ?? '—' },
                { key: 'name', header: 'Student', render: (r: any) => <span className="font-medium text-slate-900">{r.name}</span> },
                ...subjects.map((s) => ({
                  key: s.id,
                  header: s.name.length > 12 ? s.name.slice(0, 10) + '…' : s.name,
                  align: 'right' as const,
                  hideOnMobile: true,
                  render: (r: any) => {
                    const x = r.subjects.find((y: any) => y.subjectId === s.id);
                    if (!x) return '—';
                    return x.isAbsent ? <span className="text-slate-400">AB</span> : <span className={clsx('tabular-nums', x.marks !== null && !x.passed && 'font-semibold text-red-600')}>{x.marks ?? '—'}</span>;
                  },
                })),
                { key: 'total', header: 'Total', align: 'right', render: (r: any) => `${r.total}/${r.maxTotal}` },
                { key: 'percentage', header: '%', align: 'right', render: (r: any) => pct(r.percentage) },
                { key: 'grade', header: 'Grade', align: 'center' },
                { key: 'passed', header: 'Result', render: (r: any) => (r.complete ? <StatusBadge status={r.passed ? 'pass' : 'fail'} label={r.passed ? 'Pass' : 'Fail'} /> : <Badge>Incomplete</Badge>) },
                {
                  key: 'rc',
                  header: '',
                  align: 'right',
                  render: (r: any) => (
                    <Button size="sm" variant="ghost" onClick={() => openPdf(`/exams/${exam.id}/report-cards`, { studentId: r.studentId })}>
                      PDF
                    </Button>
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}

function FamilyResult({ exam }: { exam: any }) {
  const q = useQuery({ queryKey: ['results', exam.id, 'mine'], queryFn: () => get<any>(`/exams/${exam.id}/results`), enabled: exam.status === 'published', retry: false });
  if (exam.status !== 'published')
    return (
      <Card>
        <EmptyState icon={<CalendarCheck className="size-5" />} title="Results not published yet" description="You'll be notified as soon as the school publishes them. Check the Schedule tab for exam dates." />
      </Card>
    );
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <div className="space-y-6">
      {q.data.results.map((r: any) => (
        <Card
          key={r.studentId}
          title={r.name}
          subtitle={`${r.className} - ${r.sectionName}`}
          actions={
            <Button size="sm" icon={<Download className="size-4" />} onClick={() => openPdf(`/exams/${exam.id}/report-cards`, { studentId: r.studentId })}>
              Report card
            </Button>
          }
        >
          <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Percentage" value={pct(r.percentage)} />
            <Stat label="Grade" value={r.grade ?? '—'} tone="violet" />
            <Stat label="Class rank" value={r.rank ?? '—'} tone="blue" />
            <Stat label="Result" value={r.passed ? 'Pass' : r.complete ? 'Fail' : 'Incomplete'} tone={r.passed ? 'green' : 'red'} />
          </div>
          <DataTable
            rows={r.subjects}
            rowKey={(s: any) => s.subjectId}
            columns={[
              { key: 'subjectName', header: 'Subject', render: (s: any) => <span className="font-medium text-slate-900">{s.subjectName}</span> },
              { key: 'marks', header: 'Marks', align: 'right', render: (s: any) => (s.isAbsent ? 'Absent' : `${s.marks ?? '—'} / ${s.maxMarks}`) },
              { key: 'grade', header: 'Grade', align: 'center' },
              { key: 'passed', header: 'Result', render: (s: any) => (s.marks === null ? '—' : <StatusBadge status={s.passed ? 'pass' : 'fail'} label={s.passed ? 'Pass' : 'Fail'} />) },
            ]}
          />
        </Card>
      ))}
    </div>
  );
}
