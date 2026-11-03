import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Send, Trash2 } from 'lucide-react';
import { del, get, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { Button, Card, ErrorState, Field, Input, KV, Loading, Modal, PageHeader, StatusBadge, Textarea, confirm } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { Documents } from '@/components/Documents';
import { AssignmentForm } from './HomeworkPage';

export function HomeworkDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const family = user?.role.scope === 'own';
  const q = useQuery({ queryKey: ['assignment', id], queryFn: () => get<any>(`/homework/${id}`) });
  const [editing, setEditing] = useState(false);
  const [grading, setGrading] = useState<any>(null);
  const remove = useAction(() => del(`/homework/${id}`), { success: 'Assignment deleted', invalidate: [['homework']], onSuccess: () => navigate('/homework') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const a = q.data;
  return (
    <>
      <PageHeader
        back={{ to: '/homework', label: 'Homework' }}
        title={a.title}
        description={`${a.sectionLabel} · ${a.subjectName ?? 'General'} · due ${fmtDate(a.dueDate)}`}
        actions={
          a.canManage && (
            <>
              <Button variant="secondary" icon={<Trash2 className="size-4" />} onClick={async () => (await confirm({ title: 'Delete this assignment?', message: 'Submissions are deleted too.', danger: true })) && remove.mutate()}>
                Delete
              </Button>
              <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            </>
          )
        }
      />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Instructions">
            <p className="text-sm whitespace-pre-wrap text-slate-700">{a.description || 'No instructions provided.'}</p>
            <div className="mt-5">
              <Documents entity="assignment" entityId={a.id} canUpload={a.canManage} canDelete={a.canManage} compact />
            </div>
          </Card>
          {family ? (
            a.submissions.map((s: any) => <MySubmission key={s.studentId} assignment={a} s={s} />)
          ) : (
            <Card title="Submissions" padded={false}>
              <DataTable
                rows={a.submissions}
                rowKey={(s: any) => s.studentId}
                columns={[
                  { key: 'rollNo', header: 'Roll', align: 'right' },
                  { key: 'name', header: 'Student', render: (s: any) => <span className="font-medium text-slate-900">{s.name}</span> },
                  { key: 'status', header: 'Status', render: (s: any) => <StatusBadge status={s.status} /> },
                  { key: 'submittedAt', header: 'Submitted', render: (s: any) => (s.submittedAt ? fmtDateTime(s.submittedAt) : '—'), hideOnMobile: true },
                  { key: 'marks', header: 'Marks', align: 'right', render: (s: any) => (s.marks !== null && s.marks !== undefined ? `${s.marks}${a.maxMarks ? '/' + a.maxMarks : ''}` : '—') },
                  {
                    key: 'x',
                    header: '',
                    align: 'right',
                    render: (s: any) =>
                      a.canManage && (
                        <Button size="sm" variant={s.status === 'submitted' || s.status === 'late' ? 'subtle' : 'ghost'} onClick={() => setGrading(s)}>
                          {s.status === 'graded' ? 'Edit feedback' : 'Review'}
                        </Button>
                      ),
                  },
                ]}
              />
            </Card>
          )}
        </div>
        <Card title="Details">
          <KV
            cols={2}
            items={[
              ['Class', a.sectionLabel],
              ['Subject', a.subjectName],
              ['Teacher', a.teacherName],
              ['Due', fmtDate(a.dueDate)],
              ['Max marks', a.maxMarks],
              ['Submitted', `${a.submissions.filter((s: any) => s.id).length} / ${a.submissions.length}`],
            ]}
          />
        </Card>
      </div>
      <AssignmentForm open={editing} onClose={() => setEditing(false)} initial={{ ...a, subjectId: a.subjectId ?? '', maxMarks: a.maxMarks ?? '' }} submit={(v) => put(`/homework/${a.id}`, v)} />
      <GradeModal assignment={a} s={grading} onClose={() => setGrading(null)} />
    </>
  );
}

function MySubmission({ assignment, s }: { assignment: any; s: any }) {
  const { user } = useAuth();
  const [content, setContent] = useState(s.content ?? '');
  const submit = useAction(() => post(`/homework/${assignment.id}/submit`, { studentId: s.studentId, content }), { success: 'Submitted — your teacher has been notified', invalidate: [['assignment'], ['homework']] });
  const graded = s.status === 'graded';
  return (
    <Card title={user?.role.key === 'parent' ? `${s.name}'s submission` : 'Your submission'} actions={<StatusBadge status={s.status} />}>
      {graded && (
        <div className="mb-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
          <p className="font-medium">
            Reviewed{s.marks !== null ? ` · ${s.marks}${assignment.maxMarks ? '/' + assignment.maxMarks : ''}` : ''}
          </p>
          {s.feedback && <p className="mt-1">{s.feedback}</p>}
        </div>
      )}
      <Field label="Your answer / notes">
        <Textarea rows={5} value={content} disabled={graded} onChange={(e) => setContent(e.target.value)} placeholder="Write your answer or describe what you've attached." />
      </Field>
      {s.id && (
        <div className="mt-4">
          <p className="label">Attachments</p>
          <Documents entity="submission" entityId={s.id} canUpload={!graded} canDelete={!graded} compact />
        </div>
      )}
      {!graded && (
        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-slate-500">{s.id ? 'Save your answer first, then attach files.' : 'Submit once to enable file attachments.'}</span>
          <Button icon={<Send className="size-4" />} loading={submit.isPending} onClick={() => submit.mutate()}>
            {s.id ? 'Update submission' : 'Submit'}
          </Button>
        </div>
      )}
    </Card>
  );
}

function GradeModal({ assignment, s, onClose }: { assignment: any; s: any; onClose: () => void }) {
  const [marks, setMarks] = useState('');
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    setMarks(s?.marks != null ? String(s.marks) : '');
    setFeedback(s?.feedback ?? '');
  }, [s]);
  const save = useAction(() => post(`/homework/${assignment.id}/grade`, { studentId: s.studentId, marks: marks === '' ? null : Number(marks), feedback }), {
    success: 'Feedback saved',
    invalidate: [['assignment']],
    onSuccess: onClose,
  });
  return (
    <Modal
      open={!!s}
      onClose={onClose}
      title={`Review · ${s?.name ?? ''}`}
      footer={
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          Save feedback
        </Button>
      }
    >
      {s && (
        <div className="space-y-4">
          <div className="rounded-lg bg-slate-50 p-3 text-sm whitespace-pre-wrap text-slate-700">{s.content || <span className="text-slate-400">No written answer</span>}</div>
          {s.id && <Documents entity="submission" entityId={s.id} canUpload={false} canDelete={false} compact />}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={`Marks${assignment.maxMarks ? ` / ${assignment.maxMarks}` : ''}`}>
              <Input type="number" value={marks} onChange={(e) => setMarks(e.target.value)} />
            </Field>
            <Field label="Feedback" className="sm:col-span-2">
              <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} />
            </Field>
          </div>
        </div>
      )}
    </Modal>
  );
}
