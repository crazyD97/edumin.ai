/** Public, unauthenticated admission enquiry & application form for one school. */
import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Upload } from 'lucide-react';
import { ApiError, get, post } from '@/lib/api';
import { applyBranding } from '@/lib/branding';
import { currentSlug } from '@/lib/tenant';
import { titleCase } from '@/lib/format';
import { Button, ErrorState, Field, Input, Loading, Select, Tabs, Textarea } from '@/components/ui';

export function ApplyPage() {
  const params = useParams();
  const slug = params.slug ?? currentSlug() ?? '';
  const school = useQuery({ queryKey: ['public-school', slug], queryFn: () => get<any>(`/public/schools/${slug}`), enabled: !!slug, retry: false });
  const meta = useQuery({ queryKey: ['public-classes', slug], queryFn: () => get<any>(`/public/schools/${slug}/classes`), enabled: !!school.data });
  const [tab, setTab] = useState<'application' | 'enquiry'>('application');
  const [f, setF] = useState<Record<string, string>>({ relation: 'father' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ kind: string; no?: string; id?: string; token?: string } | null>(null);
  useEffect(() => applyBranding(school.data ?? null), [school.data]);

  if (!slug) return <ErrorState error={new Error('No school specified')} />;
  if (school.isLoading) return <Loading className="h-screen" />;
  if (school.error) return <ErrorState error={new Error('School not found')} />;
  const s = school.data;
  const set = (k: string) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      if (tab === 'enquiry') {
        await post(`/public/schools/${slug}/enquiries`, { studentName: f.studentName, guardianName: f.guardianName, phone: f.phone, email: f.email, classId: f.classId, message: f.message });
        setDone({ kind: 'enquiry' });
      } else {
        const r = await post<{ id: string; applicationNo: string; uploadToken: string }>(`/public/schools/${slug}/applications`, {
          classId: f.classId,
          student: { firstName: f.firstName, lastName: f.lastName, dateOfBirth: f.dob, gender: f.gender, previousSchool: f.previousSchool, address: f.address },
          guardian: { name: f.guardianName, relation: f.relation, phone: f.phone, email: f.email, occupation: f.occupation },
        });
        setDone({ kind: 'application', no: r.applicationNo, id: r.id, token: r.uploadToken });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        if (err.code !== 'VALIDATION_ERROR') setErrors({ _: err.message });
        else setErrors({ ...err.fieldErrors, _: 'Please check the highlighted fields.' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-4">
          {s.branding.logoUrl ? <img src={s.branding.logoUrl} alt="" className="size-10 object-contain" /> : <span className="grid size-10 place-items-center rounded-lg bg-brand font-bold text-white">{s.name[0]}</span>}
          <div>
            <p className="font-semibold text-slate-900">{s.name}</p>
            <p className="text-xs text-slate-500">Admissions {meta.data?.academicYear ? `· ${meta.data.academicYear.name}` : ''}</p>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-8">
        {done ? (
          <div className="card p-8 text-center">
            <CheckCircle2 className="mx-auto mb-3 size-12 text-emerald-500" />
            <h1 className="text-xl font-semibold">{done.kind === 'enquiry' ? 'Thank you for your enquiry' : 'Application submitted'}</h1>
            <p className="mt-2 text-sm text-slate-600">{done.kind === 'enquiry' ? 'Our admissions team will contact you shortly.' : `Your application number is ${done.no}. Keep it for future reference.`}</p>
            {done.token && <UploadDocs id={done.id!} token={done.token} />}
          </div>
        ) : (
          <form onSubmit={submit} className="card p-6">
            <h1 className="text-xl font-semibold">Admissions</h1>
            <p className="mt-1 mb-5 text-sm text-slate-500">Apply online or send us an enquiry.{s.branding.phone ? ` Questions? Call ${s.branding.phone}.` : ''}</p>
            <Tabs
              tabs={[
                { value: 'application', label: 'Apply for admission' },
                { value: 'enquiry', label: 'Quick enquiry' },
              ]}
              value={tab}
              onChange={setTab}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              {tab === 'enquiry' ? (
                <Field label="Student name" required error={errors.studentName} className="sm:col-span-2">
                  <Input value={f.studentName ?? ''} onChange={set('studentName')} required />
                </Field>
              ) : (
                <>
                  <Field label="Student first name" required error={errors['student.firstName']}>
                    <Input value={f.firstName ?? ''} onChange={set('firstName')} required />
                  </Field>
                  <Field label="Last name">
                    <Input value={f.lastName ?? ''} onChange={set('lastName')} />
                  </Field>
                  <Field label="Date of birth">
                    <Input type="date" value={f.dob ?? ''} onChange={set('dob')} />
                  </Field>
                  <Field label="Gender">
                    <Select value={f.gender ?? ''} onChange={set('gender')} placeholder="Select" options={['male', 'female', 'other'].map((g) => ({ value: g, label: titleCase(g) }))} />
                  </Field>
                  <Field label="Previous school">
                    <Input value={f.previousSchool ?? ''} onChange={set('previousSchool')} />
                  </Field>
                </>
              )}
              <Field label="Class" required={tab === 'application'} error={errors.classId}>
                <Select value={f.classId ?? ''} onChange={set('classId')} placeholder="Choose class" options={(meta.data?.classes ?? []).map((c: any) => ({ value: c.id, label: c.name }))} required={tab === 'application'} />
              </Field>
              <Field label="Parent / guardian name" required error={errors.guardianName ?? errors['guardian.name']}>
                <Input value={f.guardianName ?? ''} onChange={set('guardianName')} required />
              </Field>
              {tab === 'application' && (
                <Field label="Relation">
                  <Select value={f.relation} onChange={set('relation')} options={['father', 'mother', 'guardian'].map((g) => ({ value: g, label: titleCase(g) }))} />
                </Field>
              )}
              <Field label="Phone" required error={errors.phone ?? errors['guardian.phone']}>
                <Input value={f.phone ?? ''} onChange={set('phone')} required />
              </Field>
              <Field label="Email" error={errors.email ?? errors['guardian.email']}>
                <Input type="email" value={f.email ?? ''} onChange={set('email')} />
              </Field>
              {tab === 'application' ? (
                <Field label="Address" className="sm:col-span-2">
                  <Textarea value={f.address ?? ''} onChange={set('address')} />
                </Field>
              ) : (
                <Field label="Message" className="sm:col-span-2">
                  <Textarea value={f.message ?? ''} onChange={set('message')} />
                </Field>
              )}
            </div>
            {errors._ && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{errors._}</p>}
            <Button type="submit" loading={busy} className="mt-6 w-full sm:w-auto">
              {tab === 'enquiry' ? 'Send enquiry' : 'Submit application'}
            </Button>
          </form>
        )}
      </main>
    </div>
  );
}

function UploadDocs({ id, token }: { id: string; token: string }) {
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/public/applications/${id}/documents?token=${encodeURIComponent(token)}`, { method: 'POST', body: fd });
    setBusy(false);
    if (res.ok) setUploaded((u) => [...u, file.name]);
  };
  return (
    <div className="mx-auto mt-6 max-w-sm text-left">
      <p className="mb-2 text-sm font-medium text-slate-700">Attach documents (optional)</p>
      <p className="mb-3 text-xs text-slate-500">Birth certificate, previous report card, photograph — PDF or image, up to 10 MB each.</p>
      <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 py-4 text-sm text-slate-600 hover:border-brand">
        <Upload className="size-4" /> {busy ? 'Uploading…' : 'Choose file'}
        <input type="file" className="hidden" accept="application/pdf,image/*" onChange={(e) => onFile(e.target.files?.[0])} />
      </label>
      {uploaded.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-emerald-700">
          {uploaded.map((u) => (
            <li key={u}>✓ {u}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
