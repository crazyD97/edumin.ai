import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Copy, Layers, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { del, get, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useClasses, useSections, useSubjects, useTeachers, useYears, toOptions } from '@/lib/hooks';
import { fmtDate, titleCase } from '@/lib/format';
import { Badge, Button, Card, Checkbox, EmptyState, Loading, Menu, MenuItem, Modal, PageHeader, Select, StatusBadge, Tabs, confirm } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { FormModal } from '@/components/FormModal';

type Tab = 'sections' | 'classes' | 'subjects' | 'years';

export function AcademicsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'sections';
  return (
    <>
      <PageHeader title="Classes & Subjects" description="Define your school's academic structure: years, classes, sections, subjects and teachers." />
      <Tabs
        tabs={[
          { value: 'sections', label: 'Sections & teachers' },
          { value: 'classes', label: 'Classes' },
          { value: 'subjects', label: 'Subjects' },
          { value: 'years', label: 'Academic years' },
        ]}
        value={tab}
        onChange={(t) => setParams({ tab: t })}
      />
      {tab === 'sections' && <Sections />}
      {tab === 'classes' && <Classes />}
      {tab === 'subjects' && <Subjects />}
      {tab === 'years' && <Years />}
    </>
  );
}

function Sections() {
  const { can } = useAuth();
  const years = useYears();
  const [yearId, setYearId] = useState('');
  const sections = useSections(yearId || undefined);
  const classes = useClasses();
  const teachers = useTeachers();
  const [editing, setEditing] = useState<any>(null);
  const [allocating, setAllocating] = useState<any>(null);
  const remove = useAction((id: string) => del(`/sections/${id}`), { success: 'Section deleted', invalidate: [['sections']] });
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
        <Select className="w-48" value={yearId} onChange={(e) => setYearId(e.target.value)} placeholder="Current year" options={toOptions(years.data, (y) => y.name + (y.isCurrent ? ' (current)' : ''))} />
        <div className="flex-1" />
        {can('academics.create') && (
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing({})}>
            Add section
          </Button>
        )}
      </div>
      <DataTable
        rows={sections.data}
        loading={sections.isLoading}
        error={sections.error}
        rowKey={(s) => s.id}
        columns={[
          { key: 'label', header: 'Section', render: (s) => <span className="font-medium text-slate-900">{s.label}</span> },
          { key: 'classTeacherName', header: 'Class teacher', render: (s) => s.classTeacherName ?? <Badge tone="amber">Not assigned</Badge> },
          { key: 'studentCount', header: 'Students', align: 'right', render: (s) => `${s.studentCount}${s.capacity ? ` / ${s.capacity}` : ''}` },
          { key: 'room', header: 'Room', hideOnMobile: true },
          {
            key: 'actions',
            header: '',
            align: 'right',
            render: (s) =>
              can('academics.edit') && (
                <Menu trigger={<Button size="sm" variant="ghost" aria-label="Actions"><MoreHorizontal className="size-4" /></Button>}>
                  {(close) => (
                    <>
                      <MenuItem icon={<Layers className="size-4" />} onClick={() => (close(), setAllocating(s))}>
                        Subjects & teachers
                      </MenuItem>
                      <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), setEditing(s))}>
                        Edit
                      </MenuItem>
                      {can('academics.delete') && (
                        <MenuItem
                          danger
                          icon={<Trash2 className="size-4" />}
                          onClick={async () => {
                            close();
                            if (await confirm({ title: `Delete ${s.label}?`, danger: true, confirmLabel: 'Delete' })) remove.mutate(s.id);
                          }}
                        >
                          Delete
                        </MenuItem>
                      )}
                    </>
                  )}
                </Menu>
              ),
          },
        ]}
        empty={<EmptyState title="No sections in this year" description="Add sections, or copy the structure from a previous year under Academic years." />}
      />
      <FormModal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? `Edit ${editing.label}` : 'Add section'}
        initial={editing ?? {}}
        fields={[
          ...(editing?.id ? [] : [{ name: 'classId', label: 'Class', type: 'select' as const, required: true, options: toOptions(classes.data, (c) => c.name), span: 1 as const }]),
          { name: 'name', label: 'Section name', required: true, placeholder: 'A', span: 1 },
          { name: 'classTeacherId', label: 'Class teacher', type: 'select', options: toOptions(teachers.data, (t) => t.fullName), span: 1 },
          { name: 'capacity', label: 'Capacity', type: 'number', span: 1 },
          { name: 'room', label: 'Room', span: 1 },
        ]}
        submit={(v) => {
          const body: Record<string, any> = { ...v, capacity: v.capacity ? Number(v.capacity) : null, academicYearId: yearId || undefined };
          return editing?.id ? put(`/sections/${editing.id}`, { name: body.name, classTeacherId: body.classTeacherId, capacity: body.capacity, room: body.room }) : post('/sections', body);
        }}
        success="Section saved"
        invalidate={[['sections']]}
      />
      <AllocationModal section={allocating} onClose={() => setAllocating(null)} />
    </Card>
  );
}

function AllocationModal({ section, onClose }: { section: any; onClose: () => void }) {
  const subjects = useSubjects();
  const teachers = useTeachers();
  const current = useQuery({ queryKey: ['section-subjects', section?.id], queryFn: () => get<any[]>(`/sections/${section.id}/subjects`), enabled: !!section });
  const [rows, setRows] = useState<Record<string, { on: boolean; teacherId: string }>>({});
  useEffect(() => {
    if (current.data) setRows(Object.fromEntries(current.data.map((r) => [r.subjectId, { on: true, teacherId: r.teacherId ?? '' }])));
  }, [current.data]);
  const save = useAction(
    () =>
      put(`/sections/${section.id}/subjects`, {
        items: Object.entries(rows)
          .filter(([, r]) => r.on)
          .map(([subjectId, r]) => ({ subjectId, teacherId: r.teacherId || null })),
      }),
    { success: 'Subjects updated', invalidate: [['section-subjects']], onSuccess: onClose },
  );
  return (
    <Modal
      open={!!section}
      onClose={onClose}
      size="lg"
      title={`Subjects · ${section?.label ?? ''}`}
      description="Tick the subjects this section studies and assign a subject teacher."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      {current.isLoading ? (
        <Loading />
      ) : (
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {subjects.data?.map((s) => {
            const r = rows[s.id] ?? { on: false, teacherId: '' };
            return (
              <div key={s.id} className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center">
                <div className="flex-1">
                  <Checkbox checked={r.on} onChange={(on) => setRows((p) => ({ ...p, [s.id]: { ...r, on } }))} label={<span className="font-medium">{s.name}</span>} />
                </div>
                <Select className="sm:w-64" disabled={!r.on} value={r.teacherId} onChange={(e) => setRows((p) => ({ ...p, [s.id]: { ...r, teacherId: e.target.value } }))} placeholder="No teacher" options={toOptions(teachers.data, (t) => t.fullName)} />
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function Classes() {
  const { can } = useAuth();
  const classes = useClasses();
  const [editing, setEditing] = useState<any>(null);
  const remove = useAction((id: string) => del(`/classes/${id}`), { success: 'Class deleted', invalidate: [['classes']] });
  return (
    <Card padded={false}>
      <div className="flex justify-end border-b border-slate-100 p-3">
        {can('academics.create') && (
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ level: (classes.data?.length ?? 0) + 1 })}>
            Add class
          </Button>
        )}
      </div>
      <DataTable
        rows={classes.data}
        loading={classes.isLoading}
        rowKey={(c) => c.id}
        columns={[
          { key: 'name', header: 'Class', render: (c) => <span className="font-medium text-slate-900">{c.name}</span> },
          { key: 'level', header: 'Order / level', align: 'right' },
          {
            key: 'a',
            header: '',
            align: 'right',
            render: (c) => (
              <div className="flex justify-end gap-1">
                {can('academics.edit') && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                    Edit
                  </Button>
                )}
                {can('academics.delete') && (
                  <Button size="sm" variant="ghost" onClick={async () => (await confirm({ title: `Delete ${c.name}?`, danger: true })) && remove.mutate(c.id)}>
                    Delete
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />
      <FormModal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit class' : 'Add class'}
        initial={editing ?? {}}
        fields={[
          { name: 'name', label: 'Name', required: true, placeholder: 'Grade 1, Nursery, Class X…', span: 1 },
          { name: 'level', label: 'Level', type: 'number', required: true, hint: 'Used for ordering and promotion (next level = next class)', span: 1 },
        ]}
        submit={(v) => (editing?.id ? put(`/classes/${editing.id}`, { ...v, level: Number(v.level) }) : post('/classes', { ...v, level: Number(v.level) }))}
        success="Class saved"
        invalidate={[['classes']]}
      />
    </Card>
  );
}

function Subjects() {
  const { can } = useAuth();
  const subjects = useSubjects();
  const [editing, setEditing] = useState<any>(null);
  const remove = useAction((id: string) => del(`/subjects/${id}`), { success: 'Subject deleted', invalidate: [['subjects']] });
  return (
    <Card padded={false}>
      <div className="flex justify-end border-b border-slate-100 p-3">
        {can('academics.create') && (
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ type: 'theory' })}>
            Add subject
          </Button>
        )}
      </div>
      <DataTable
        rows={subjects.data}
        loading={subjects.isLoading}
        rowKey={(s) => s.id}
        columns={[
          { key: 'name', header: 'Subject', render: (s) => <span className="font-medium text-slate-900">{s.name}</span> },
          { key: 'code', header: 'Code' },
          { key: 'type', header: 'Type', render: (s) => titleCase(s.type) },
          {
            key: 'a',
            header: '',
            align: 'right',
            render: (s) => (
              <div className="flex justify-end gap-1">
                {can('academics.edit') && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                )}
                {can('academics.delete') && (
                  <Button size="sm" variant="ghost" onClick={async () => (await confirm({ title: `Delete ${s.name}?`, message: 'Allocations and timetable slots for this subject are removed too.', danger: true })) && remove.mutate(s.id)}>
                    Delete
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />
      <FormModal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit subject' : 'Add subject'}
        initial={editing ?? {}}
        fields={[
          { name: 'name', label: 'Name', required: true, span: 1 },
          { name: 'code', label: 'Code', span: 1 },
          { name: 'type', label: 'Type', type: 'select', options: ['theory', 'practical', 'activity'].map((t) => ({ value: t, label: titleCase(t) })), required: true },
        ]}
        submit={(v) => (editing?.id ? put(`/subjects/${editing.id}`, v) : post('/subjects', v))}
        success="Subject saved"
        invalidate={[['subjects']]}
      />
    </Card>
  );
}

function Years() {
  const { can } = useAuth();
  const years = useYears();
  const [editing, setEditing] = useState<any>(null);
  const [copying, setCopying] = useState<any>(null);
  const [fromYear, setFromYear] = useState('');
  const copy = useAction(() => post(`/academic-years/${copying.id}/copy-structure`, { fromYearId: fromYear }), {
    success: (r: any) => `${r.sectionsCreated} sections copied`,
    invalidate: [['sections']],
    onSuccess: () => setCopying(null),
  });
  return (
    <Card padded={false}>
      <div className="flex justify-end border-b border-slate-100 p-3">
        {can('academics.create') && (
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing({})}>
            Add academic year
          </Button>
        )}
      </div>
      <DataTable
        rows={years.data}
        loading={years.isLoading}
        rowKey={(y) => y.id}
        columns={[
          { key: 'name', header: 'Year', render: (y) => <span className="font-medium text-slate-900">{y.name}</span> },
          { key: 'startDate', header: 'Starts', render: (y) => fmtDate(y.startDate) },
          { key: 'endDate', header: 'Ends', render: (y) => fmtDate(y.endDate) },
          { key: 'isCurrent', header: 'Status', render: (y) => (y.isCurrent ? <StatusBadge status="active" label="Current" /> : null) },
          {
            key: 'a',
            header: '',
            align: 'right',
            render: (y) => (
              <div className="flex justify-end gap-1">
                {can('academics.create') && (
                  <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => setCopying(y)}>
                    Copy structure
                  </Button>
                )}
                {can('academics.edit') && (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(y)}>
                    Edit
                  </Button>
                )}
              </div>
            ),
          },
        ]}
      />
      <FormModal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit academic year' : 'Add academic year'}
        initial={editing ?? {}}
        fields={[
          { name: 'name', label: 'Name', required: true, placeholder: '2027-28' },
          { name: 'startDate', label: 'Start date', type: 'date', required: true, span: 1 },
          { name: 'endDate', label: 'End date', type: 'date', required: true, span: 1 },
          { name: 'isCurrent', label: 'Set as the current academic year', type: 'checkbox' },
        ]}
        submit={(v) => (editing?.id ? put(`/academic-years/${editing.id}`, v) : post('/academic-years', v))}
        success="Academic year saved"
        invalidate={[['years'], ['sections'], ['dashboard']]}
      />
      <Modal
        open={!!copying}
        onClose={() => setCopying(null)}
        size="sm"
        title={`Copy structure into ${copying?.name ?? ''}`}
        description="Creates the same sections, class teachers and subject allocations. Existing sections are kept."
        footer={
          <Button disabled={!fromYear} loading={copy.isPending} onClick={() => copy.mutate()}>
            Copy
          </Button>
        }
      >
        <Select value={fromYear} onChange={(e) => setFromYear(e.target.value)} placeholder="Copy from…" options={toOptions(years.data?.filter((y) => y.id !== copying?.id), (y) => y.name)} />
      </Modal>
    </Card>
  );
}
