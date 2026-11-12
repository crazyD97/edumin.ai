import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  AlertTriangle,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  CreditCard,
  GraduationCap,
  Handshake,
  Megaphone,
  NotebookPen,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import { get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, fmtDate, fmtDateTime, fmtShort, fmtTime, money, num, pct, titleCase } from '@/lib/format';
import { Avatar, Badge, Card, EmptyState, ErrorState, LinkButton, Loading, PageHeader, ProgressBar, Stat, StatusBadge, clsx } from '@/components/ui';
import { BarsChart, ChartEmpty, TrendChart } from '@/components/charts';

export function DashboardPage() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => get<any>('/dashboard') });
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return (
    <>
      <PageHeader title={`${greet}, ${user?.fullName.split(' ')[0]}`} description={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} />
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} retry={q.refetch} />
      ) : q.data.kind === 'admin' ? (
        <AdminDashboard d={q.data} />
      ) : q.data.kind === 'teacher' ? (
        <TeacherDashboard d={q.data} />
      ) : q.data.kind === 'accountant' ? (
        <AccountantDashboard d={q.data} />
      ) : (
        <FamilyDashboard d={q.data} />
      )}
    </>
  );
}

const trendData = (rows: { date: string; percentage: number }[] = []) => rows.map((r) => ({ ...r, label: fmtShort(r.date) }));

function EventsCard({ events }: { events?: any[] }) {
  return (
    <Card title="Upcoming events" actions={<Link to="/calendar" className="text-xs font-medium text-brand-700 hover:underline">Calendar</Link>} padded={false}>
      {events?.length ? (
        <ul className="divide-y divide-slate-100">
          {events.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-5 py-3">
              <div className="grid w-11 shrink-0 place-items-center rounded-lg bg-brand-50 py-1 text-center leading-tight text-brand-700">
                <span className="text-[10px] font-semibold uppercase">{new Date(e.startDate).toLocaleString('en', { month: 'short' })}</span>
                <span className="text-base font-semibold">{new Date(e.startDate).getDate()}</span>
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">{e.title}</p>
                <p className="truncate text-xs text-slate-500">
                  {titleCase(e.type)}
                  {e.location ? ` · ${e.location}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No upcoming events" icon={<CalendarDays className="size-5" />} />
      )}
    </Card>
  );
}

function ExamsCard({ exams }: { exams?: any[] }) {
  return (
    <Card title="Upcoming examinations" padded={false}>
      {exams?.length ? (
        <ul className="divide-y divide-slate-100">
          {exams.map((e) => (
            <li key={e.id}>
              <Link to={`/exams/${e.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50">
                <div>
                  <p className="text-sm font-medium text-slate-800">{e.name}</p>
                  <p className="text-xs text-slate-500">
                    {fmtDate(e.startDate)} · {e.papers} papers
                  </p>
                </div>
                <StatusBadge status={e.status} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No exams scheduled" icon={<BookOpen className="size-5" />} />
      )}
    </Card>
  );
}

function PerformanceCard({ p, title = 'Academic performance' }: { p: any; title?: string }) {
  return (
    <Card title={title} subtitle={p ? `Latest published: ${p.examName}` : undefined} actions={p && <Link to={`/exams/${p.examId}`} className="text-xs font-medium text-brand-700 hover:underline">View results</Link>}>
      {p?.byClass?.length ? (
        <>
          <div className="mb-3 flex gap-6 text-sm">
            <span>
              Average <b className="tabular-nums">{pct(p.average)}</b>
            </span>
            <span>
              Pass rate <b className="tabular-nums">{pct(p.passRate)}</b>
            </span>
          </div>
          <BarsChart data={p.byClass} xKey="label" series={[{ key: 'average', label: 'Average %' }]} format={(v) => `${v}%`} height={220} />
        </>
      ) : (
        <ChartEmpty>No published results yet</ChartEmpty>
      )}
    </Card>
  );
}

function SetupBanner() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['setup'], queryFn: () => get<any>('/setup/status'), enabled: can('settings.edit') });
  if (!q.data || q.data.ready) return null;
  return (
    <Link to="/setup" className="flex flex-col gap-3 rounded-xl border border-brand-200 bg-brand-50 p-4 transition hover:border-brand sm:flex-row sm:items-center">
      <div className="flex-1">
        <p className="font-semibold text-slate-900">Finish setting up your school</p>
        <p className="text-sm text-slate-600">
          {q.data.completed} of {q.data.total} steps done — next: {q.data.items.find((i: any) => !i.done && !i.optional)?.label}
        </p>
        <div className="mt-2 max-w-sm">
          <ProgressBar value={(q.data.completed / q.data.total) * 100} />
        </div>
      </div>
      <span className="text-sm font-medium text-brand-700">Continue setup →</span>
    </Link>
  );
}

function AdminDashboard({ d }: { d: any }) {
  const { hasFeature } = useAuth();
  const a = d.attendanceToday;
  return (
    <div className="space-y-6">
      <SetupBanner />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Active students" value={num(d.totals.students)} sub={`${d.totals.male} boys · ${d.totals.female} girls`} icon={<GraduationCap className="size-5" />} to="/students" />
        <Stat label="Teachers" value={num(d.totals.teachers)} sub={`${d.totals.sections} class sections`} icon={<Users className="size-5" />} tone="violet" to="/staff" />
        <Stat
          label="Today's attendance"
          value={a.marked ? pct(a.percentage) : '—'}
          sub={`${a.sectionsMarked}/${a.sectionsTotal} sections marked · ${a.absent ?? 0} absent`}
          icon={<ClipboardCheck className="size-5" />}
          tone="green"
          to="/attendance"
        />
        {d.fees ? (
          <Stat label="Collected this month" value={money(d.fees.collectedThisMonth, { compact: true })} sub={`${money(d.fees.collectedToday, { compact: true })} today`} icon={<Wallet className="size-5" />} tone="blue" to="/fees" />
        ) : (
          <Stat label="Pending leave requests" value={d.pendingLeave} icon={<Clock className="size-5" />} tone="amber" to="/attendance?tab=leave" />
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {d.fees && <Stat label="Outstanding fees" value={money(d.fees.outstanding, { compact: true })} sub={`${money(d.fees.overdue, { compact: true })} overdue`} icon={<CreditCard className="size-5" />} tone="red" to="/fees?tab=invoices" />}
        {d.admissions && <Stat label="New enquiries" value={d.admissions.newEnquiries} sub={`${d.admissions.pendingApplications} applications pending`} icon={<UserPlus className="size-5" />} tone="amber" to="/admissions" />}
        <Stat label="Pending leave requests" value={d.pendingLeave} icon={<Clock className="size-5" />} tone="violet" to="/attendance?tab=leave" />
        {d.upcomingExams && <Stat label="Upcoming exams" value={d.upcomingExams.length} sub={d.upcomingExams[0] ? `${d.upcomingExams[0].name} · ${fmtShort(d.upcomingExams[0].startDate)}` : 'None scheduled'} icon={<BookOpen className="size-5" />} to="/exams" />}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        {hasFeature('attendance') && (
          <Card title="Attendance trend" subtitle="School-wide, last 3 weeks">
            {d.attendanceTrend?.length ? <TrendChart data={trendData(d.attendanceTrend)} xKey="label" series={[{ key: 'percentage', label: 'Attendance' }]} format={(v) => `${v}%`} area yDomain={[60, 100]} /> : <ChartEmpty />}
          </Card>
        )}
        {d.fees && (
          <Card title="Fee collection" subtitle="Last 6 months">
            {d.fees.trend.length ? <BarsChart data={d.fees.trend} xKey="month" series={[{ key: 'amount', label: 'Collected' }]} format={(v) => money(v, { compact: true })} /> : <ChartEmpty />}
          </Card>
        )}
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">{d.performance !== undefined && <PerformanceCard p={d.performance} />}</div>
        <div className="space-y-6">
          {d.upcomingEvents && <EventsCard events={d.upcomingEvents} />}
          {d.upcomingExams && <ExamsCard exams={d.upcomingExams} />}
        </div>
      </div>
    </div>
  );
}

function TeacherDashboard({ d }: { d: any }) {
  const unmarked = d.sections.filter((s: any) => s.isClassTeacher && !s.markedToday);
  return (
    <div className="space-y-6">
      {unmarked.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-2 text-sm text-amber-900">
            <AlertTriangle className="size-4" /> Attendance not yet marked today for {unmarked.map((s: any) => s.label).join(', ')}
          </p>
          <LinkButton to={`/attendance?section=${unmarked[0].id}`} variant="primary" icon={<ClipboardCheck className="size-4" />}>
            Mark attendance
          </LinkButton>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="My classes" value={d.totals.sections} sub={`Class teacher of ${d.totals.classTeacherOf}`} icon={<Users className="size-5" />} />
        <Stat label="Students taught" value={num(d.totals.students)} icon={<GraduationCap className="size-5" />} tone="violet" to="/students" />
        <Stat label="Periods today" value={d.today?.length ?? 0} icon={<Clock className="size-5" />} tone="blue" to="/timetable" />
        <Stat label="Leave to review" value={d.pendingLeave} icon={<CheckCircle2 className="size-5" />} tone="amber" to="/attendance?tab=leave" />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Today's timetable" padded={false} actions={<Link to="/timetable" className="text-xs font-medium text-brand-700 hover:underline">Full week</Link>}>
          {d.today?.length ? (
            <ul className="divide-y divide-slate-100">
              {d.today.map((p: any) => (
                <li key={p.id + p.periodId} className={clsx('flex items-center gap-3 px-5 py-3', p.substitutedBy && 'opacity-50')}>
                  <div className="w-16 shrink-0 text-xs text-slate-500 tabular-nums">{fmtTime(p.period.startTime)}</div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{p.subjectName ?? 'Free'}</p>
                    <p className="truncate text-xs text-slate-500">{p.sectionLabel}</p>
                  </div>
                  {p.isSubstitution && <Badge tone="violet">Substitute</Badge>}
                  {p.substitutedBy && <Badge>Covered</Badge>}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No classes today" icon={<CalendarDays className="size-5" />} />
          )}
        </Card>
        <Card title="My classes" padded={false} className="xl:col-span-2">
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-slate-50/70">
                <tr>
                  <th className="th">Class</th>
                  <th className="th">Subjects</th>
                  <th className="th text-right">Students</th>
                  <th className="th">Today</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.sections.map((s: any) => (
                  <tr key={s.id}>
                    <td className="td font-medium text-slate-900">
                      {s.label} {s.isClassTeacher && <Badge tone="brand">Class teacher</Badge>}
                    </td>
                    <td className="td max-w-56 truncate">{s.subjects ?? '—'}</td>
                    <td className="td text-right tabular-nums">{s.students}</td>
                    <td className="td">{s.markedToday ? <StatusBadge status="completed" label="Marked" /> : <StatusBadge status="pending" label="Not marked" />}</td>
                    <td className="td text-right">
                      <Link className="text-xs font-medium text-brand-700 hover:underline" to={`/attendance?section=${s.id}`}>
                        Attendance
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">{d.performance !== undefined && <PerformanceCard p={d.performance} title="My students' performance" />}</div>
        <div className="space-y-6">
          <Card title="Homework" padded={false} actions={<Link to="/homework" className="text-xs font-medium text-brand-700 hover:underline">All</Link>}>
            {d.homework?.length ? (
              <ul className="divide-y divide-slate-100">
                {d.homework.map((h: any) => (
                  <li key={h.id}>
                    <Link to={`/homework/${h.id}`} className="block px-5 py-3 hover:bg-slate-50">
                      <p className="truncate text-sm font-medium text-slate-800">{h.title}</p>
                      <p className="text-xs text-slate-500">
                        {h.sectionLabel} · due {fmtShort(h.dueDate)} · {h.submitted} submitted{h.toGrade ? `, ${h.toGrade} to review` : ''}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No homework yet" icon={<NotebookPen className="size-5" />} />
            )}
          </Card>
          {d.upcomingExams && <ExamsCard exams={d.upcomingExams} />}
          {d.meetings && <MeetingsCard meetings={d.meetings} />}
        </div>
      </div>
    </div>
  );
}

function MeetingsCard({ meetings }: { meetings: any[] }) {
  return (
    <Card title="Upcoming meetings" padded={false} actions={<Link to="/meetings" className="text-xs font-medium text-brand-700 hover:underline">All</Link>}>
      {meetings.length ? (
        <ul className="divide-y divide-slate-100">
          {meetings.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">{m.studentName ?? 'Meeting'} · {m.teacherName}</p>
                <p className="text-xs text-slate-500">{fmtDateTime(m.startsAt)}</p>
              </div>
              <StatusBadge status={m.status} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No upcoming meetings" icon={<Handshake className="size-5" />} />
      )}
    </Card>
  );
}

function AccountantDashboard({ d }: { d: any }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Collected today" value={money(d.collections.today)} sub={`${d.collections.todayCount} receipts`} icon={<Wallet className="size-5" />} tone="green" />
        <Stat label="This month" value={money(d.collections.month, { compact: true })} icon={<TrendingUp className="size-5" />} tone="blue" />
        <Stat label="Outstanding" value={money(d.dues.outstanding, { compact: true })} sub={`${money(d.dues.overdue, { compact: true })} overdue`} icon={<CreditCard className="size-5" />} tone="amber" to="/fees?tab=invoices" />
        <Stat label="Defaulters" value={d.dues.defaulters} sub="Students with overdue dues" icon={<AlertTriangle className="size-5" />} tone="red" to="/reports?r=fee-pending" />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Monthly collections" subtitle="Last 12 months" className="xl:col-span-2">
          {d.trend.length ? <BarsChart data={d.trend} xKey="month" series={[{ key: 'amount', label: 'Collected' }]} format={(v) => money(v, { compact: true })} height={260} /> : <ChartEmpty />}
        </Card>
        <Card title="This month by method">
          {d.byMethod.length ? (
            <ul className="space-y-3">
              {d.byMethod
                .sort((a: any, b: any) => b.amount - a.amount)
                .map((m: any) => {
                  const total = d.byMethod.reduce((s: number, x: any) => s + x.amount, 0);
                  return (
                    <li key={m.method}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span className="text-slate-600">{titleCase(m.method)}</span>
                        <span className="font-medium tabular-nums">{money(m.amount, { compact: true })}</span>
                      </div>
                      <ProgressBar value={(m.amount / total) * 100} />
                    </li>
                  );
                })}
            </ul>
          ) : (
            <ChartEmpty>No collections this month</ChartEmpty>
          )}
        </Card>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Recent payments" padded={false} actions={<Link to="/fees?tab=payments" className="text-xs font-medium text-brand-700 hover:underline">All payments</Link>}>
          <ul className="divide-y divide-slate-100">
            {d.recentPayments.map((p: any) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800">{p.studentName}</p>
                  <p className="text-xs text-slate-500">
                    {p.receiptNo} · {titleCase(p.method)} · {ago(p.paidAt)}
                  </p>
                </div>
                <span className="text-sm font-semibold tabular-nums">{money(p.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Top defaulters" padded={false} actions={<Link to="/reports?r=fee-pending" className="text-xs font-medium text-brand-700 hover:underline">Full report</Link>}>
          {d.defaulters.length ? (
            <ul className="divide-y divide-slate-100">
              {d.defaulters.map((s: any) => (
                <li key={s.studentId}>
                  <Link to={`/fees/students/${s.studentId}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{s.name}</p>
                      <p className="text-xs text-slate-500">{s.admissionNo}</p>
                    </div>
                    <span className="text-sm font-semibold text-red-600 tabular-nums">{money(s.balance)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No overdue dues" icon={<CheckCircle2 className="size-5" />} />
          )}
        </Card>
      </div>
    </div>
  );
}

function FamilyDashboard({ d }: { d: any }) {
  const { hasFeature } = useAuth();
  return (
    <div className="space-y-6">
      {d.children.length === 0 && <Card><EmptyState title="No student linked to this account" description="Please contact the school office." /></Card>}
      {d.children.map((c: any) => (
        <div key={c.id} className="space-y-4">
          <div className="flex items-center gap-3">
            <Avatar name={c.name} src={c.photoUrl} size={44} />
            <div>
              <p className="text-base font-semibold text-slate-900">{c.name}</p>
              <p className="text-sm text-slate-500">
                {c.classLabel ?? 'Not enrolled'} · {c.admissionNo}
                {c.classTeacher ? ` · Class teacher: ${c.classTeacher}` : ''}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {c.attendance && (
              <Stat
                label="Attendance this year"
                value={pct(c.attendance.percentage)}
                sub={`${c.attendance.absent} absences in ${c.attendance.days} days${c.attendance.todayStatus ? ` · today: ${titleCase(c.attendance.todayStatus)}` : ''}`}
                icon={<ClipboardCheck className="size-5" />}
                tone={c.attendance.percentage !== null && c.attendance.percentage < 75 ? 'red' : 'green'}
                to="/attendance"
              />
            )}
            {c.latestResult !== undefined && (
              <Stat
                label={c.latestResult ? `Result · ${c.latestResult.examName}` : 'Latest result'}
                value={c.latestResult ? pct(c.latestResult.percentage) : '—'}
                sub={c.latestResult ? `Grade ${c.latestResult.grade ?? '—'} · Rank ${c.latestResult.rank ?? '—'}` : 'No published results yet'}
                icon={<BookOpen className="size-5" />}
                tone="violet"
                to={c.latestResult ? `/exams/${c.latestResult.examId}` : '/exams'}
              />
            )}
            {c.fees && (
              <Stat
                label="Fee balance"
                value={money(c.fees.balance)}
                sub={c.fees.overdue > 0 ? `${money(c.fees.overdue)} overdue` : c.fees.nextDue ? `Next due ${fmtDate(c.fees.nextDue)}` : 'All clear'}
                icon={<CreditCard className="size-5" />}
                tone={c.fees.overdue > 0 ? 'red' : 'blue'}
                to={`/fees/students/${c.id}`}
              />
            )}
            {c.homework && (
              <Stat label="Homework pending" value={c.homework.filter((h: any) => h.status === 'pending').length} sub={`${c.homework.length} recent assignments`} icon={<NotebookPen className="size-5" />} tone="amber" to="/homework" />
            )}
          </div>
          <div className="grid gap-6 xl:grid-cols-2">
            {c.latestResult && (
              <Card title={`${c.latestResult.examName} — subject marks`}>
                <BarsChart data={c.latestResult.subjects.map((s: any) => ({ name: s.name, pct: s.marks === null ? 0 : Math.round((s.marks / s.max) * 100) }))} xKey="name" series={[{ key: 'pct', label: 'Score %' }]} format={(v) => `${v}%`} height={230} />
              </Card>
            )}
            {c.homework && (
              <Card title="Homework" padded={false} actions={<Link to="/homework" className="text-xs font-medium text-brand-700 hover:underline">All</Link>}>
                {c.homework.length ? (
                  <ul className="divide-y divide-slate-100">
                    {c.homework.map((h: any) => (
                      <li key={h.id}>
                        <Link to={`/homework/${h.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-800">{h.title}</p>
                            <p className="text-xs text-slate-500">
                              {h.subject} · due {fmtShort(h.dueDate)}
                            </p>
                          </div>
                          <StatusBadge status={h.status === 'pending' && h.dueDate < new Date().toISOString().slice(0, 10) ? 'missing' : h.status} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState title="No homework this week" icon={<NotebookPen className="size-5" />} />
                )}
              </Card>
            )}
          </div>
        </div>
      ))}
      <div className="grid gap-6 xl:grid-cols-3">
        {d.today && (
          <Card title="Today's timetable" padded={false}>
            <ul className="divide-y divide-slate-100">
              {d.today.map((p: any, i: number) => (
                <li key={i} className={clsx('flex items-center gap-3 px-5 py-2.5', p.isBreak && 'bg-slate-50')}>
                  <span className="w-16 shrink-0 text-xs text-slate-500 tabular-nums">{fmtTime(p.startTime)}</span>
                  <span className="text-sm font-medium text-slate-800">{p.isBreak ? 'Break' : (p.subject ?? '—')}</span>
                  {p.teacher && <span className="ml-auto truncate text-xs text-slate-500">{p.teacher}</span>}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {hasFeature('communication') && (
          <Card title="Announcements" padded={false} actions={<Link to="/announcements" className="text-xs font-medium text-brand-700 hover:underline">All</Link>} className={d.today ? '' : 'xl:col-span-2'}>
            {d.announcements?.length ? (
              <ul className="divide-y divide-slate-100">
                {d.announcements.map((a: any) => (
                  <li key={a.id} className="px-5 py-3">
                    <p className="flex items-center gap-2 text-sm font-medium text-slate-800">
                      {a.isPinned && <Megaphone className="size-3.5 text-brand" />}
                      {a.title}
                    </p>
                    <p className="line-clamp-2 text-xs text-slate-500">{a.body}</p>
                    <p className="mt-1 text-[11px] text-slate-400">{ago(a.createdAt)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No announcements" icon={<Megaphone className="size-5" />} />
            )}
          </Card>
        )}
        <div className="space-y-6">
          {d.upcomingEvents && <EventsCard events={d.upcomingEvents} />}
          {d.meetings && <MeetingsCard meetings={d.meetings} />}
        </div>
      </div>
    </div>
  );
}
