/** Public page behind the QR codes on certificates and ID cards. */
import { useEffect } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, ShieldAlert, ShieldX } from 'lucide-react';
import { get } from '@/lib/api';
import { applyBranding } from '@/lib/branding';
import { fmtDate, titleCase } from '@/lib/format';
import { Loading } from '@/components/ui';

export function VerifyPage() {
  const { kind, id } = useParams();
  const q = useQuery({ queryKey: ['verify', kind, id], queryFn: () => get<any>(`/public/verify/${kind}/${id}`), retry: false });
  useEffect(() => {
    if (q.data?.school) applyBranding({ name: q.data.school.name, branding: { primaryColor: q.data.school.primaryColor, logoUrl: q.data.school.logoUrl } });
  }, [q.data]);
  if (q.isLoading) return <Loading className="h-screen" />;
  const d = q.data;
  const found = d && d.valid !== undefined && d.school;
  const revoked = d?.revokedAt;
  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4 py-10">
      <div className="card w-full max-w-md overflow-hidden">
        <div className={found && d.valid ? 'bg-emerald-600 p-6 text-white' : 'bg-red-600 p-6 text-white'}>
          <div className="flex items-center gap-3">
            {found && d.valid ? <BadgeCheck className="size-9" /> : revoked ? <ShieldX className="size-9" /> : <ShieldAlert className="size-9" />}
            <div>
              <p className="text-lg font-semibold">{!found ? 'Not found' : d.valid ? 'Verified — genuine' : revoked ? 'Revoked' : 'No longer valid'}</p>
              <p className="text-sm text-white/85">{found ? d.title : 'This document is not in our records.'}</p>
            </div>
          </div>
        </div>
        {found && (
          <div className="space-y-4 p-6">
            <div className="flex items-center gap-3">
              {d.school.logoUrl ? <img src={d.school.logoUrl} alt="" className="size-10 object-contain" /> : <span className="grid size-10 place-items-center rounded-lg bg-brand font-bold text-white">{d.school.name[0]}</span>}
              <p className="font-semibold text-slate-900">{d.school.name}</p>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-slate-500">Name</dt>
              <dd className="font-medium text-slate-900">{d.holder}</dd>
              {d.admissionNo && (
                <>
                  <dt className="text-slate-500">Admission no.</dt>
                  <dd className="font-medium text-slate-900">{d.admissionNo}</dd>
                </>
              )}
              {d.serialNo && (
                <>
                  <dt className="text-slate-500">Certificate no.</dt>
                  <dd className="font-mono text-slate-900">{d.serialNo}</dd>
                  <dt className="text-slate-500">Issued on</dt>
                  <dd className="text-slate-900">{fmtDate(d.issuedAt)}</dd>
                </>
              )}
              {d.status && (
                <>
                  <dt className="text-slate-500">Status</dt>
                  <dd className="text-slate-900">{titleCase(d.status)}</dd>
                </>
              )}
              {Object.entries(d.details ?? {})
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="text-slate-900">{/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? fmtDate(String(v)) : String(v)}</dd>
                  </div>
                ))}
            </dl>
            {revoked && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">Revoked on {fmtDate(d.revokedAt)}{d.revokeReason ? ` — ${d.revokeReason}` : ''}.</p>}
            <p className="text-xs text-slate-400">Verified against the school's records on {new Date().toLocaleString('en-IN')}.</p>
          </div>
        )}
      </div>
    </div>
  );
}
