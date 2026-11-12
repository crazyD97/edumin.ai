/** Issue and list certificates for one student (used on the student profile). */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Award, FileDown, Plus } from 'lucide-react';
import { get, openPdf, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction } from '@/lib/hooks';
import { fmtDateTime } from '@/lib/format';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { DataTable } from '@/components/DataTable';

export const CERT_TYPES: Record<string, string> = { transfer: 'Transfer Certificate (TC)', bonafide: 'Bonafide Certificate', character: 'Character Certificate', study: 'Study Certificate' };

const FIELD_LABELS: Record<string, { label: string; type?: 'date' | 'textarea' | 'select'; options?: string[] }> = {
  dateOfLeaving: { label: 'Date of leaving', type: 'date' },
  reasonForLeaving: { label: 'Reason for leaving' },
  lastClass: { label: 'Class last studied' },
  qualifiedForPromotion: { label: 'Qualified for promotion', type: 'select', options: ['Yes', 'No', 'Not applicable'] },
  feesPaidUpTo: { label: 'School dues paid up to', },
  subjectsStudied: { label: 'Subjects studied', type: 'textarea' },
  conduct: { label: 'General conduct', type: 'select', options: ['Excellent', 'Very good', 'Good', 'Satisfactory'] },
  purpose: { label: 'Purpose (issued for)' },
  studiedFrom: { label: 'Studied from', type: 'date' },
  studiedTo: { label: 'Studied to', type: 'date' },
  remarks: { label: 'Remarks', type: 'textarea' },
};

export function CertificatesPanel({ studentId, studentStatus }: { studentId: string; studentStatus: string }) {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['certificates', studentId], queryFn: () => get<any[]>('/certificates', { studentId }) });
  const [issuing, setIssuing] = useState(false);
  return (
    <Card
      title="Certificates"
      subtitle="Every certificate has a serial number and a QR code anyone can scan to verify it."
      padded={false}
      actions={
        can('certificates.create') && (
          <Button icon={<Plus className="size-4" />} onClick={() => setIssuing(true)}>
            Issue certificate
          </Button>
        )
      }
    >
      <DataTable
        rows={list.data}
        loading={list.isLoading}
        rowKey={(r: any) => r.id}
        columns={[
          { key: 'type', header: 'Certificate', render: (r: any) => <span className="font-medium text-slate-900">{CERT_TYPES[r.type] ?? r.type}</span> },
          { key: 'serialNo', header: 'Serial no.', render: (r: any) => <span className="font-mono text-xs">{r.serialNo}</span> },
          { key: 'issuedAt', header: 'Issued', render: (r: any) => `${fmtDateTime(r.issuedAt)}${r.issuedByName ? ` · ${r.issuedByName}` : ''}` },
          { key: 'status', header: 'Status', render: (r: any) => (r.revokedAt ? <Badge tone="red">Revoked</Badge> : <Badge tone="green">Valid</Badge>) },
          {
            key: 'x',
            header: '',
            align: 'right',
            render: (r: any) => (
              <Button size="sm" variant="ghost" icon={<FileDown className="size-4" />} onClick={() => openPdf(`/certificates/${r.id}/pdf`)}>
                PDF
              </Button>
            ),
          },
        ]}
        empty={<EmptyState icon={<Award className="size-5" />} title="No certificates issued yet" />}
      />
      <IssueModal open={issuing} onClose={() => setIssuing(false)} studentId={studentId} studentStatus={studentStatus} />
    </Card>
  );
}

function IssueModal({ open, onClose, studentId, studentStatus }: { open: boolean; onClose: () => void; studentId: string; studentStatus: string }) {
  const [type, setType] = useState('bonafide');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [markTransferred, setMarkTransferred] = useState(true);
  const defaults = useQuery({ queryKey: ['cert-defaults', studentId, type], queryFn: () => get<Record<string, string>>(`/students/${studentId}/certificates/defaults`, { type }), enabled: open });
  useEffect(() => {
    if (defaults.data) setFields(defaults.data);
  }, [defaults.data]);
  const issue = useAction(() => post<any>(`/students/${studentId}/certificates`, { type, fields, markTransferred: type === 'transfer' && markTransferred }), {
    success: (r: any) => `Issued ${r.serialNo}`,
    invalidate: [['certificates'], ['student']],
    onSuccess: (r: any) => {
      onClose();
      openPdf(`/certificates/${r.id}/pdf`);
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Issue certificate"
      description="Student details (name, parents, date of birth, class) are filled in from their record automatically."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={issue.isPending} onClick={() => issue.mutate()}>
            Issue & print
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Certificate" className="sm:col-span-2">
          <Select value={type} onChange={(e) => setType(e.target.value)} options={Object.entries(CERT_TYPES).map(([value, label]) => ({ value, label }))} />
        </Field>
        {Object.keys(fields).map((k) => {
          const meta = FIELD_LABELS[k] ?? { label: k };
          const set = (v: string) => setFields((p) => ({ ...p, [k]: v }));
          return (
            <Field key={k} label={meta.label} className={meta.type === 'textarea' ? 'sm:col-span-2' : ''}>
              {meta.type === 'textarea' ? (
                <Textarea rows={2} value={fields[k] ?? ''} onChange={(e) => set(e.target.value)} />
              ) : meta.type === 'select' ? (
                <Select value={fields[k] ?? ''} onChange={(e) => set(e.target.value)} options={(meta.options ?? []).map((o) => ({ value: o, label: o }))} />
              ) : (
                <Input type={meta.type ?? 'text'} value={fields[k] ?? ''} onChange={(e) => set(e.target.value)} />
              )}
            </Field>
          );
        })}
        {type === 'transfer' && studentStatus === 'active' && (
          <div className="sm:col-span-2">
            <Checkbox checked={markTransferred} onChange={setMarkTransferred} label="Also mark the student as transferred (keeps their history, deactivates portal logins)" />
          </div>
        )}
      </div>
    </Modal>
  );
}
