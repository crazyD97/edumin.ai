import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameMonth, isToday, startOfMonth, startOfWeek } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { EVENT_TYPES } from '@edumin/shared';
import { del, get, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useClasses } from '@/lib/hooks';
import { fmtDate, fmtTime, isoDate, titleCase } from '@/lib/format';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Loading, PageHeader, clsx, confirm, type Tone } from '@/components/ui';
import { FormModal } from '@/components/FormModal';

const TYPE_STYLE: Record<string, { dot: string; tone: Tone }> = {
  holiday: { dot: 'bg-emerald-500', tone: 'green' },
  exam: { dot: 'bg-violet-500', tone: 'violet' },
  ptm: { dot: 'bg-amber-500', tone: 'amber' },
  sports: { dot: 'bg-sky-500', tone: 'blue' },
  function: { dot: 'bg-pink-500', tone: 'red' },
  event: { dot: 'bg-brand', tone: 'brand' },
  other: { dot: 'bg-slate-400', tone: 'gray' },
};
const LABEL: Record<string, string> = { ptm: 'Parent–teacher meeting', function: 'Annual function' };

export function CalendarPage() {
  const { can, hasFeature } = useAuth();
  const navigate = useNavigate();
  const classes = useClasses();
  const [month, setMonth] = useState(startOfMonth(new Date()));
  const [selected, setSelected] = useState<string>(isoDate(new Date()));
  const [editing, setEditing] = useState<any>(null);
  const gridStart = startOfWeek(month, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  const from = isoDate(gridStart);
  const to = isoDate(gridEnd);
  const q = useQuery({ queryKey: ['calendar', from, to], queryFn: () => get<any[]>('/calendar', { from, to }) });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });
  const itemsOn = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const it of q.data ?? []) {
      for (const d of eachDayOfInterval({ start: new Date(it.startDate + 'T00:00:00'), end: new Date(it.endDate + 'T00:00:00') })) {
        const k = isoDate(d);
        map.set(k, [...(map.get(k) ?? []), it]);
      }
    }
    return map;
  }, [q.data]);
  const remove = useAction((id: string) => del(`/events/${id}`), { success: 'Event deleted', invalidate: [['calendar'], ['dashboard']] });
  const dayItems = itemsOn.get(selected) ?? [];
  const canEdit = hasFeature('events') && can('events.create');

  return (
    <>
      <PageHeader
        title="School calendar"
        description="Events, holidays, examinations and meetings."
        actions={
          canEdit && (
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ type: 'event', startDate: selected, endDate: selected, classIds: [] })}>
              Add event
            </Button>
          )
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card padded={false}>
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-base font-semibold">{format(month, 'MMMM yyyy')}</h2>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">
                <ChevronLeft className="size-4" />
              </Button>
              <Button size="sm" variant="secondary" onClick={() => (setMonth(startOfMonth(new Date())), setSelected(isoDate(new Date())))}>
                Today
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-7 border-b border-slate-100 text-center text-xs font-medium text-slate-500">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <div key={d} className="py-2">
                {d}
              </div>
            ))}
          </div>
          {q.isLoading ? (
            <Loading />
          ) : (
            <div className="grid grid-cols-7">
              {days.map((d) => {
                const k = isoDate(d);
                const items = itemsOn.get(k) ?? [];
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSelected(k)}
                    className={clsx(
                      'min-h-16 border-r border-b border-slate-100 p-1.5 text-left transition hover:bg-slate-50 sm:min-h-24',
                      !isSameMonth(d, month) && 'bg-slate-50/60 text-slate-400',
                      selected === k && 'bg-brand-50 ring-1 ring-brand-200 ring-inset',
                    )}
                  >
                    <span className={clsx('inline-grid size-6 place-items-center rounded-full text-xs font-medium', isToday(d) && 'bg-brand text-white')}>{d.getDate()}</span>
                    <div className="mt-1 space-y-0.5">
                      {items.slice(0, 3).map((it) => (
                        <div key={it.id} className="flex items-center gap-1 truncate text-[11px] text-slate-700">
                          <span className={clsx('size-1.5 shrink-0 rounded-full', TYPE_STYLE[it.type]?.dot ?? 'bg-slate-400')} />
                          <span className="hidden truncate sm:inline">{it.title}</span>
                        </div>
                      ))}
                      {items.length > 3 && <p className="hidden text-[10px] text-slate-400 sm:block">+{items.length - 3} more</p>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap gap-3 px-4 py-3 text-xs text-slate-500">
            {['event', 'holiday', 'exam', 'ptm', 'sports', 'function'].map((t) => (
              <span key={t} className="flex items-center gap-1.5">
                <span className={clsx('size-2 rounded-full', TYPE_STYLE[t].dot)} />
                {LABEL[t] ?? titleCase(t)}
              </span>
            ))}
          </div>
        </Card>
        <Card title={format(new Date(selected + 'T00:00:00'), 'EEEE, d MMMM')} padded={false}>
          {dayItems.length ? (
            <ul className="divide-y divide-slate-100">
              {dayItems.map((it) => (
                <li key={it.id} className="px-5 py-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">{it.title}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {it.startDate !== it.endDate ? `${fmtDate(it.startDate)} – ${fmtDate(it.endDate)}` : it.time ? fmtTime(it.time) : 'All day'}
                        {it.location ? ` · ${it.location}` : ''}
                      </p>
                      {it.description && <p className="mt-1.5 text-sm text-slate-600">{it.description}</p>}
                    </div>
                    <Badge tone={TYPE_STYLE[it.type]?.tone ?? 'gray'}>{LABEL[it.type] ?? titleCase(it.type)}</Badge>
                  </div>
                  <div className="mt-2 flex gap-3">
                    {it.link && (
                      <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => navigate(it.link)}>
                        Open
                      </button>
                    )}
                    {canEdit && !it.link && (
                      <>
                        <button
                          className="text-xs font-medium text-brand-700 hover:underline"
                          onClick={async () => {
                            const full = (await get<any[]>('/events', { from: it.startDate, to: it.endDate })).find((e) => e.id === it.id);
                            setEditing({ ...full, startTime: full?.startTime?.slice(0, 5) ?? '', endTime: full?.endTime?.slice(0, 5) ?? '' });
                          }}
                        >
                          Edit
                        </button>
                        {can('events.delete') && (
                          <button className="text-xs font-medium text-red-600 hover:underline" onClick={async () => (await confirm({ title: `Delete “${it.title}”?`, danger: true })) && remove.mutate(it.id)}>
                            Delete
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Nothing scheduled" />
          )}
        </Card>
      </div>
      <FormModal
        open={!!editing}
        onClose={() => setEditing(null)}
        size="lg"
        title={editing?.id ? 'Edit event' : 'Add event'}
        initial={editing ?? {}}
        fields={[
          { name: 'title', label: 'Title', required: true },
          { name: 'type', label: 'Type', type: 'select', required: true, options: EVENT_TYPES.map((t) => ({ value: t, label: LABEL[t] ?? titleCase(t) })), span: 1 },
          { name: 'location', label: 'Location', span: 1 },
          { name: 'startDate', label: 'Start date', type: 'date', required: true, span: 1 },
          { name: 'endDate', label: 'End date', type: 'date', required: true, span: 1 },
          { name: 'startTime', label: 'Start time', type: 'time', span: 1 },
          { name: 'endTime', label: 'End time', type: 'time', span: 1 },
          { name: 'description', label: 'Description', type: 'textarea' },
          { name: 'announce', label: 'Notify students, parents and staff', type: 'checkbox' },
        ]}
        submit={(v) => {
          const body = { ...v, classIds: v.classIds ?? [] };
          return editing?.id ? put(`/events/${editing.id}`, body) : post('/events', body);
        }}
        success="Event saved"
        invalidate={[['calendar'], ['dashboard']]}
      >
        {(v, set) => (
          <Field label="Classes" hint="Leave empty for a whole-school event." className="sm:col-span-2">
            <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border border-slate-200 p-3">
              {classes.data?.map((c) => (
                <Checkbox key={c.id} checked={(v.classIds ?? []).includes(c.id)} onChange={(on) => set('classIds', on ? [...(v.classIds ?? []), c.id] : (v.classIds ?? []).filter((x: string) => x !== c.id))} label={c.name} />
              ))}
            </div>
          </Field>
        )}
      </FormModal>
    </>
  );
}
