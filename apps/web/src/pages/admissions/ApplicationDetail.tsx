import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, UserCheck, XCircle } from 'lucide-react';
import { get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useSections, toOptions } from '@/lib/hooks';
import { fmtDate, fmtDateTime, titleCase } from '@/lib/format';
import { Button, Card, ErrorState, Field, Input, KV, Loading, Modal, PageHeader, Select, StatusBadge, Textarea } from '@/components/ui';
import { Documents } from '@/components/Documents';

export function ApplicationDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['application', id], queryFn: () => get<any>(`/admissions/applications/${id}`) });
  const [remarks, setRemarks] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const review = useAction((status: string) => post(`/admissions/applications/${id}/review`, { status, remarks: remarks || undefined }), {
    success: (r: any) => `Application ${titleCase(r.status).toLowerCase()}`,
    invalidate: [['application'], ['applications']],
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const a = q.data;
  const open = !['enrolled', 'rejected'].includes(a.status);
  return (
    <>
      <PageHeader
        back={{ to: '/admissions', label: 'Admissions' }}
        title={
          <span className="flex items-center gap-3">
            {a.student.firstName} {a.student.lastName} <StatusBadge status={a.status} />
          </span>
        }
        description={`${a.applicationNo} · applying for ${a.className}${a.academicYear ? ` (${a.academicYear})` : ''} · received ${fmtDate(a.createdAt)}`}
        actions={
          a.status === 'enrolled' && a.studentId ? (
            <Link to={`/students/${a.studentId}`} className="text-sm font-medium text-brand-700 hover:underline">
              View student record →
            </Link>
          ) : null
        }
      />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Student">
            <KV
              items={[
                ['Name', `${a.student.firstName} ${a.student.lastName ?? ''}`],
                ['Date of birth', fmtDate(a.student.dateOfBirth)],
                ['Gender', titleCase(a.student.gender)],
                ['Previous school', a.student.previousSchool],
                ['Address', a.student.address],
              ]}
            />
          </Card>
          <Card title="Parent / guardian">
            <KV
              items={[
                ['Name', a.guardian.name],
                ['Relation', titleCase(a.guardian.relation)],
                ['Phone', a.guardian.phone],
                ['Email', a.guardian.email],
                ['Occupation', a.guardian.occupation],
              ]}
            />
          </Card>
          <Card title="Documents">
            <Documents entity="application" entityId={a.id} canUpload={can('admissions.edit') && open} canDelete={can('admissions.edit') && open} />
          </Card>
        </div>
        <Card title="Decision">
          {a.reviewedAt && (
            <p className="mb-4 text-sm text-slate-500">
              Last reviewed {fmtDateTime(a.reviewedAt)}
              {a.remarks ? ` — “${a.remarks}”` : ''}
            </p>
          )}
          {open && (can('admissions.edit') || can('admissions.approve')) ? (
            <div className="space-y-3">
              {a.status !== 'approved' && (
                <>
                  <Field label="Remarks">
                    <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Interview notes, conditions…" />
                  </Field>
                  {a.status === 'submitted' && can('admissions.edit') && (
                    <Button variant="secondary" className="w-full" loading={review.isPending} onClick={() => review.mutate('under_review')}>
                      Mark under review
                    </Button>
                  )}
                  {can('admissions.approve') && (
                    <div className="grid grid-cols-2 gap-2">
                      <Button variant="danger" icon={<XCircle className="size-4" />} onClick={() => review.mutate('rejected')}>
                        Reject
                      </Button>
                      <Button icon={<CheckCircle2 className="size-4" />} onClick={() => review.mutate('approved')}>
                        Approve
                      </Button>
                    </div>
                  )}
                </>
              )}
              {a.status === 'approved' && can('admissions.approve') && (
                <>
                  <p className="text-sm text-slate-600">Approved. Enrol the student to create their record and generate an admission number.</p>
                  <Button className="w-full" icon={<UserCheck className="size-4" />} onClick={() => setEnrolling(true)}>
                    Enrol student
                  </Button>
                </>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">{a.status === 'enrolled' ? 'This applicant is now an enrolled student.' : 'This application is closed.'}</p>
          )}
        </Card>
      </div>
      <EnrolModal open={enrolling} onClose={() => setEnrolling(false)} app={a} />
    </>
  );
}

function EnrolModal({ open, onClose, app }: { open: boolean; onClose: () => void; app: any }) {
  const sections = useSections();
  const [sectionId, setSectionId] = useState('');
  const [admissionNo, setAdmissionNo] = useState('');
  const enrol = useAction(() => post(`/admissions/applications/${app.id}/enroll`, { sectionId, admissionNo: admissionNo || null }), {
    success: (r: any) => `Enrolled · admission no. ${r.admissionNo}`,
    invalidate: [['application'], ['applications'], ['students']],
    onSuccess: onClose,
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Enrol student"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!sectionId} loading={enrol.isPending} onClick={() => enrol.mutate()}>
            Enrol
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Section" required>
          <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)} placeholder="Choose section" options={toOptions(sections.data?.filter((s) => s.classId === app.classId), (s) => `${s.label} (${s.studentCount}${s.capacity ? '/' + s.capacity : ''})`)} />
        </Field>
        <Field label="Admission number" hint="Leave blank to generate automatically">
          <Input value={admissionNo} onChange={(e) => setAdmissionNo(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
