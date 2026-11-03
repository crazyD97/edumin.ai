import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { NotebookPen, Paperclip, Plus } from 'lucide-react';
import { get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useSections, useSubjects, toOptions } from '@/lib/hooks';
import { fmtDate, today } from '@/lib/format';
import { Button, Card, EmptyState, PageHeader, ProgressBar, Select, StatusBadge, clsx } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { FormModal } from '@/components/FormModal';

export function HomeworkPage() {
  const { can, user } = useAuth();
  const navigate = useNavigate();
  const family = user?.role.scope === 'own';
  const sections = useSections();
  const subjects = useSubjects();
  const [sectionId, setSectionId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['homework', sectionId, subjectId, status], queryFn: () => get<any[]>('/homework', { sectionId, subjectId, status }) });
  return (
    <>
      <PageHeader
        title="Homework"
        description={family ? 'Assignments, due dates and teacher feedback.' : 'Set assignments, collect submissions and give feedback.'}
        actions={
          can('homework.create') &&
          !family && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New assignment
            </Button>
          )
        }
      />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          {!family && <Select className="w-48" value={sectionId} onChange={(e) => setSectionId(e.target.value)} placeholder="All my classes" options={toOptions(sections.data, (s) => s.label)} />}
          <Select className="w-44" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder="All subjects" options={toOptions(subjects.data, (s) => s.name)} />
          <Select
            className="w-36"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="Any due date"
            options={[
              { value: 'upcoming', label: 'Upcoming' },
              { value: 'past', label: 'Past due' },
            ]}
          />
        </div>
        <DataTable
          rows={list.data}
          loading={list.isLoading}
          error={list.error}
          rowKey={(r: any) => r.id}
          onRowClick={(r: any) => navigate(`/homework/${r.id}`)}
          columns={[
            {
              key: 'title',
              header: 'Assignment',
              render: (r: any) => (
                <div>
                  <p className="flex items-center gap-1.5 font-medium text-slate-900">
                    {r.title} {r.attachments > 0 && <Paperclip className="size-3.5 text-slate-400" />}
                  </p>
                  <p className="text-xs text-slate-500">
                    {r.sectionLabel} · {r.subjectName ?? 'General'} · {r.teacherName}
                  </p>
                </div>
              ),
            },
            { key: 'dueDate', header: 'Due', render: (r: any) => <span className={clsx(r.dueDate < today() && 'text-slate-500')}>{fmtDate(r.dueDate)}</span> },
            family
              ? { key: 'myStatus', header: 'Status', render: (r: any) => <StatusBadge status={r.myStatus} /> }
              : {
                  key: 'progress',
                  header: 'Submissions',
                  render: (r: any) => (
                    <div className="w-40">
                      <div className="mb-1 flex justify-between text-xs text-slate-500">
                        <span>
                          {r.submitted}/{r.enrolled} submitted
                        </span>
                        <span>{r.graded} graded</span>
                      </div>
                      <ProgressBar value={r.enrolled ? (r.submitted / r.enrolled) * 100 : 0} />
                    </div>
                  ),
                },
          ]}
          empty={<EmptyState icon={<NotebookPen className="size-5" />} title="No homework" description={family ? 'Nothing assigned right now.' : 'Create an assignment for one of your classes.'} />}
        />
      </Card>
      <AssignmentForm open={creating} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/homework/${id}`)} />
    </>
  );
}

export function AssignmentForm({ open, onClose, initial, onSaved, submit }: { open: boolean; onClose: () => void; initial?: any; onSaved?: (id: string) => void; submit?: (v: any) => Promise<any> }) {
  const sections = useSections();
  const subjects = useSubjects();
  return (
    <FormModal
      open={open}
      onClose={onClose}
      title={initial?.id ? 'Edit assignment' : 'New assignment'}
      description="Students and parents are notified. Attach files after saving."
      initial={initial ?? { dueDate: today() }}
      fields={[
        { name: 'title', label: 'Title', required: true },
        { name: 'sectionId', label: 'Class', type: 'select', required: true, options: toOptions(sections.data, (s) => s.label), placeholder: 'Choose class', span: 1 },
        { name: 'subjectId', label: 'Subject', type: 'select', options: toOptions(subjects.data, (s) => s.name), span: 1 },
        { name: 'dueDate', label: 'Due date', type: 'date', required: true, span: 1 },
        { name: 'maxMarks', label: 'Max marks', type: 'number', span: 1, hint: 'Optional' },
        { name: 'description', label: 'Instructions', type: 'textarea' },
      ]}
      submit={(v) => {
        const body = { ...v, maxMarks: v.maxMarks ? Number(v.maxMarks) : null, subjectId: v.subjectId || null };
        return submit ? submit(body) : post('/homework', body);
      }}
      success="Assignment saved"
      invalidate={[['homework'], ['assignment']]}
      onSaved={(r) => onSaved?.(r?.id)}
    />
  );
}
