import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Plus, Scale, Trash2 } from 'lucide-react';
import { get, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useYears, toOptions } from '@/lib/hooks';
import { fmtDate } from '@/lib/format';
import { Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, StatusBadge } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { FormModal } from '@/components/FormModal';

export function ExamsPage() {
  const { can, user } = useAuth();
  const navigate = useNavigate();
  const years = useYears();
  const [yearId, setYearId] = useState('');
  const [creating, setCreating] = useState(false);
  const [scales, setScales] = useState(false);
  const list = useQuery({ queryKey: ['exams', yearId], queryFn: () => get<any[]>('/exams', { academicYearId: yearId || undefined }) });
  const grading = useQuery({ queryKey: ['grading-scales'], queryFn: () => get<any[]>('/grading-scales') });
  const admin = user?.role.scope === 'school';
  const family = user?.role.scope === 'own';
  return (
    <>
      <PageHeader
        title={family ? 'Results' : 'Examinations'}
        description={family ? 'Exam schedules, results and report cards.' : 'Schedule exams, enter marks, publish results and print report cards.'}
        actions={
          admin && (
            <>
              {can('exams.approve') && (
                <Button variant="secondary" icon={<Scale className="size-4" />} onClick={() => setScales(true)}>
                  Grading scales
                </Button>
              )}
              {can('exams.create') && (
                <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                  New examination
                </Button>
              )}
            </>
          )
        }
      />
      <Card padded={false}>
        <div className="border-b border-slate-100 p-3">
          <Select className="w-48" value={yearId} onChange={(e) => setYearId(e.target.value)} placeholder="Current year" options={toOptions(years.data, (y) => y.name)} />
        </div>
        <DataTable
          rows={list.data}
          loading={list.isLoading}
          error={list.error}
          rowKey={(r: any) => r.id}
          onRowClick={(r: any) => navigate(`/exams/${r.id}`)}
          columns={[
            {
              key: 'name',
              header: 'Examination',
              render: (r: any) => (
                <div>
                  <p className="font-medium text-slate-900">{r.name}</p>
                  <p className="text-xs text-slate-500">{r.term}</p>
                </div>
              ),
            },
            { key: 'dates', header: 'Dates', render: (r: any) => (r.startDate ? `${fmtDate(r.startDate)} – ${fmtDate(r.endDate)}` : '—') },
            { key: 'classCount', header: 'Classes', align: 'right', hideOnMobile: true },
            { key: 'paperCount', header: 'Papers', align: 'right', hideOnMobile: true },
            { key: 'scaleName', header: 'Grading', hideOnMobile: true },
            { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} label={r.status === 'published' ? 'Results published' : undefined} /> },
          ]}
          empty={<EmptyState icon={<BookOpen className="size-5" />} title="No examinations" description={admin ? 'Create an exam, add its schedule per class, then enter marks.' : undefined} />}
        />
      </Card>
      <FormModal
        open={creating}
        onClose={() => setCreating(false)}
        title="New examination"
        initial={{ gradingScaleId: grading.data?.find((g) => g.isDefault)?.id }}
        fields={[
          { name: 'name', label: 'Name', required: true, placeholder: 'Half Yearly Examination' },
          { name: 'term', label: 'Term', placeholder: 'Term 1', span: 1 },
          { name: 'gradingScaleId', label: 'Grading scale', type: 'select', options: toOptions(grading.data, (g) => g.name), span: 1 },
          { name: 'startDate', label: 'Start date', type: 'date', span: 1 },
          { name: 'endDate', label: 'End date', type: 'date', span: 1 },
          { name: 'description', label: 'Description', type: 'textarea' },
        ]}
        submit={(v) => post('/exams', { ...v, academicYearId: yearId || undefined })}
        success="Examination created"
        invalidate={[['exams']]}
        onSaved={(r) => navigate(`/exams/${r.id}`)}
      />
      <ScalesModal open={scales} onClose={() => setScales(false)} scales={grading.data ?? []} />
    </>
  );
}

function ScalesModal({ open, onClose, scales }: { open: boolean; onClose: () => void; scales: any[] }) {
  const [editing, setEditing] = useState<any>(null);
  const save = useAction(() => (editing.id ? put(`/grading-scales/${editing.id}`, editing) : post('/grading-scales', editing)), {
    success: 'Grading scale saved',
    invalidate: [['grading-scales']],
    onSuccess: () => setEditing(null),
  });
  const band = (i: number, patch: any) => setEditing((e: any) => ({ ...e, bands: e.bands.map((b: any, j: number) => (j === i ? { ...b, ...patch } : b)) }));
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Grading scales" description="Each school defines its own grades. Percentages at or above “min” get that grade.">
      {editing ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Overall pass %">
              <Input type="number" value={editing.passPercent} onChange={(e) => setEditing({ ...editing, passPercent: Number(e.target.value) })} />
            </Field>
          </div>
          <table className="min-w-full text-sm">
            <thead>
              <tr>
                <th className="th">Grade</th>
                <th className="th">Min %</th>
                <th className="th">Grade point</th>
                <th className="th">Remark</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {editing.bands.map((b: any, i: number) => (
                <tr key={i}>
                  <td className="p-1">
                    <Input value={b.grade} onChange={(e) => band(i, { grade: e.target.value })} />
                  </td>
                  <td className="p-1">
                    <Input type="number" value={b.min} onChange={(e) => band(i, { min: Number(e.target.value) })} />
                  </td>
                  <td className="p-1">
                    <Input type="number" value={b.point ?? ''} onChange={(e) => band(i, { point: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  </td>
                  <td className="p-1">
                    <Input value={b.remark ?? ''} onChange={(e) => band(i, { remark: e.target.value })} />
                  </td>
                  <td className="p-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ ...editing, bands: editing.bands.filter((_: any, j: number) => j !== i) })} aria-label="Remove grade">
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-between">
            <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => setEditing({ ...editing, bands: [...editing.bands, { grade: '', min: 0 }] })}>
              Add grade
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Back
              </Button>
              <Button loading={save.isPending} onClick={() => save.mutate()}>
                Save scale
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {scales.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
              <div>
                <p className="font-medium">
                  {s.name} {s.isDefault && <span className="text-xs text-slate-500">(default)</span>}
                </p>
                <p className="text-xs text-slate-500">
                  Pass {s.passPercent}% · {s.bands.map((b: any) => b.grade).join(', ')}
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setEditing(structuredClone(s))}>
                Edit
              </Button>
            </div>
          ))}
          <Button variant="subtle" icon={<Plus className="size-4" />} onClick={() => setEditing({ name: '', passPercent: 33, isDefault: false, bands: [{ grade: 'A', min: 80 }, { grade: 'B', min: 60 }, { grade: 'C', min: 40 }, { grade: 'F', min: 0 }] })}>
            New grading scale
          </Button>
        </div>
      )}
    </Modal>
  );
}
