/** Certificate register for the whole school, plus ID card printing. */
import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Award, FileDown, IdCard } from 'lucide-react';
import { get, openPdf, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useSections, toOptions } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Badge, Button, Card, EmptyState, Field, PageHeader, Select, Textarea, Modal } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { CERT_TYPES } from './CertificatesPanel';

export function CertificatesPage() {
  const { can } = useAuth();
  const sections = useSections();
  const [type, setType] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [revoking, setRevoking] = useState<any>(null);
  const [reason, setReason] = useState('');
  const list = useQuery({ queryKey: ['certificates', 'all', type], queryFn: () => get<any[]>('/certificates', { type }) });
  const revoke = useAction(() => post(`/certificates/${revoking.id}/revoke`, { reason }), {
    success: 'Certificate revoked — the QR code now shows it as invalid',
    invalidate: [['certificates']],
    onSuccess: () => {
      setRevoking(null);
      setReason('');
    },
  });
  return (
    <>
      <PageHeader title="Certificates & ID cards" description="Issue certificates from a student's profile. Everything issued is listed here." />
      <Card title="Print ID cards" subtitle="Credit-card size (CR80), 10 per A4 sheet, with photo and a QR code for verification." className="mb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Students in" className="sm:w-64">
            <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)} placeholder="All classes" options={toOptions(sections.data, (s) => s.label)} />
          </Field>
          <Button icon={<IdCard className="size-4" />} onClick={() => openPdf('/id-cards/students', { sectionId })}>
            Student ID cards
          </Button>
          {can('staff.view') && (
            <Button variant="secondary" icon={<IdCard className="size-4" />} onClick={() => openPdf('/id-cards/staff')}>
              Staff ID cards
            </Button>
          )}
        </div>
      </Card>
      <Card padded={false} title="Certificate register">
        <div className="border-b border-slate-100 p-3">
          <Select className="w-64" value={type} onChange={(e) => setType(e.target.value)} placeholder="All certificate types" options={Object.entries(CERT_TYPES).map(([value, label]) => ({ value, label }))} />
        </div>
        <DataTable
          rows={list.data}
          loading={list.isLoading}
          rowKey={(r: any) => r.id}
          columns={[
            { key: 'serialNo', header: 'Serial no.', render: (r: any) => <span className="font-mono text-xs">{r.serialNo}</span> },
            { key: 'type', header: 'Certificate', render: (r: any) => CERT_TYPES[r.type] ?? r.type },
            {
              key: 'student',
              header: 'Student',
              render: (r: any) => (
                <Link className="font-medium text-brand-700 hover:underline" to={`/students/${r.studentId}`}>
                  {r.studentName} <span className="font-normal text-slate-500">· {r.admissionNo}</span>
                </Link>
              ),
            },
            { key: 'issuedAt', header: 'Issued', render: (r: any) => `${fmtDateTime(r.issuedAt)}${r.issuedByName ? ` · ${r.issuedByName}` : ''}`, hideOnMobile: true },
            { key: 'status', header: 'Status', render: (r: any) => (r.revokedAt ? <Badge tone="red">Revoked</Badge> : <Badge tone="green">Valid</Badge>) },
            {
              key: 'x',
              header: '',
              align: 'right',
              render: (r: any) => (
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" icon={<FileDown className="size-4" />} onClick={() => openPdf(`/certificates/${r.id}/pdf`)}>
                    PDF
                  </Button>
                  {can('certificates.delete') && !r.revokedAt && (
                    <Button size="sm" variant="ghost" onClick={() => setRevoking(r)}>
                      Revoke
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
          empty={<EmptyState icon={<Award className="size-5" />} title="No certificates issued yet" description="Open a student's profile → Certificates to issue a TC, bonafide or character certificate." />}
        />
      </Card>
      <Modal
        open={!!revoking}
        onClose={() => setRevoking(null)}
        size="sm"
        title={`Revoke ${revoking?.serialNo ?? ''}?`}
        description="The certificate stays in the register but its QR code will show it as revoked."
        footer={
          <Button variant="danger" disabled={reason.length < 3} loading={revoke.isPending} onClick={() => revoke.mutate()}>
            Revoke
          </Button>
        }
      >
        <Field label="Reason">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Issued with wrong details; reissued as …" />
        </Field>
      </Modal>
    </>
  );
}
