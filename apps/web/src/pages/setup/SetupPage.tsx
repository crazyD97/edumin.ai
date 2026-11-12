/** Onboarding checklist with one-click actions for the heavy lifting. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Circle, FileSpreadsheet, KeyRound, Layers, Sparkles, Upload, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { download, get, post } from '@/lib/api';
import { useAction, useSections, toOptions } from '@/lib/hooks';
import { Badge, Button, Card, Checkbox, Field, Input, Loading, Modal, PageHeader, ProgressBar, Select, clsx } from '@/components/ui';

function savePdf(base64: string, filename: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function SetupPage() {
  const q = useQuery({ queryKey: ['setup'], queryFn: () => get<any>('/setup/status') });
  const [action, setAction] = useState<string | null>(null);
  if (q.isLoading || !q.data) return <Loading />;
  const d = q.data;
  const icon: Record<string, typeof Layers> = { classes: Layers, staff: UserPlus, parents: KeyRound };
  return (
    <>
      <PageHeader title="Set up your school" description="Work through the list — most schools are ready in under an hour." />
      <Card className="mb-6">
        <div className="flex items-center gap-4">
          <div className="grid size-12 place-items-center rounded-xl bg-brand-50 text-brand">
            <Sparkles className="size-6" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-slate-900">{d.ready ? 'Your school is ready to go live 🎉' : `${d.completed} of ${d.total} steps done`}</p>
            <div className="mt-2 max-w-md">
              <ProgressBar value={(d.completed / d.total) * 100} tone={d.ready ? 'green' : 'brand'} />
            </div>
          </div>
        </div>
      </Card>
      <Card padded={false}>
        <ul className="divide-y divide-slate-100">
          {d.items.map((i: any, idx: number) => {
            const Icon = icon[i.action] ?? ArrowRight;
            return (
              <li key={i.key} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <div className="flex flex-1 items-start gap-3">
                  {i.done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" /> : <Circle className="mt-0.5 size-5 shrink-0 text-slate-300" />}
                  <div>
                    <p className={clsx('font-medium', i.done ? 'text-slate-500' : 'text-slate-900')}>
                      {idx + 1}. {i.label} {i.optional && <Badge>Optional</Badge>}
                    </p>
                    <p className="text-sm text-slate-500">{i.detail}</p>
                  </div>
                </div>
                {i.action ? (
                  <Button variant={i.done ? 'secondary' : 'primary'} size="sm" icon={<Icon className="size-4" />} onClick={() => setAction(i.action)}>
                    {i.action === 'classes' ? 'Quick setup' : i.action === 'staff' ? 'Import staff' : 'Create parent logins'}
                  </Button>
                ) : (
                  <Link to={i.link} className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[13px] font-medium text-brand-700 hover:bg-brand-50">
                    {i.done ? 'Review' : 'Open'} <ArrowRight className="size-3.5" />
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      <ClassesModal open={action === 'classes'} onClose={() => setAction(null)} />
      <StaffImportModal open={action === 'staff'} onClose={() => setAction(null)} />
      <ParentLoginsModal open={action === 'parents'} onClose={() => setAction(null)} />
    </>
  );
}

function ClassesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const presets = useQuery({ queryKey: ['setup-presets'], queryFn: () => get<{ classes: string[]; subjects: string[] }>('/setup/presets'), enabled: open });
  const [classes, setClasses] = useState<string[]>([]);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [sections, setSections] = useState('A, B');
  useEffect(() => {
    if (presets.data) {
      setClasses(presets.data.classes.filter((c) => c.startsWith('Class')).slice(0, 10));
      setSubjects(presets.data.subjects.slice(0, 6));
    }
  }, [presets.data]);
  const save = useAction(() => post<any>('/setup/classes', { classes, subjects, sections: sections.split(',').map((s) => s.trim()).filter(Boolean) }), {
    success: (r: any) => `Created ${r.classes} classes, ${r.sections} sections and ${r.subjects} subjects`,
    invalidate: [['setup'], ['classes'], ['sections'], ['subjects']],
    onSuccess: onClose,
  });
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Quick class setup"
      description="Creates the classes, a set of sections for each in the current academic year, and assigns the subjects to every section. Anything that already exists is kept."
      footer={
        <Button loading={save.isPending} disabled={!classes.length} onClick={() => save.mutate()}>
          Create
        </Button>
      }
    >
      {!presets.data ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <Field label="Classes">
            <div className="flex flex-wrap gap-2">
              {presets.data.classes.map((c) => (
                <button key={c} type="button" onClick={() => toggle(classes, setClasses, c)} className={clsx('rounded-lg border px-2.5 py-1 text-sm', classes.includes(c) ? 'border-brand bg-brand text-white' : 'border-slate-300 text-slate-700 hover:border-slate-400')}>
                  {c}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Sections in each class" hint="Comma separated">
            <Input value={sections} onChange={(e) => setSections(e.target.value)} />
          </Field>
          <Field label="Subjects">
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {presets.data.subjects.map((s) => (
                <Checkbox key={s} checked={subjects.includes(s)} onChange={() => toggle(subjects, setSubjects, s)} label={s} />
              ))}
            </div>
          </Field>
        </div>
      )}
    </Modal>
  );
}

function StaffImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/staff/import?dryRun=${dryRun}`, { method: 'POST', body: fd, credentials: 'include' });
      const j = await res.json();
      if (!j.success) throw new Error(j.error.message);
      setResult(j.data);
      if (!dryRun && j.data.slipsPdf) {
        savePdf(j.data.slipsPdf, 'staff-login-details.pdf');
        toast.success(`Imported ${j.data.imported} staff — login slips downloaded`);
        qc.invalidateQueries({ queryKey: ['setup'] });
        qc.invalidateQueries({ queryKey: ['staff'] });
      }
    } catch (e) {
      setResult({ errors: [{ row: 0, message: (e as Error).message }], valid: 0 });
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setFile(null);
    setResult(null);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="Import staff from Excel"
      description="Columns: fullName, email or phone, role (teacher, accountant, principal…), employeeCode, designation, department, password (optional — generated if blank)."
      footer={
        result?.imported ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" disabled={!file} loading={busy} onClick={() => run(true)}>
              Validate
            </Button>
            <Button disabled={!result || result.errors.length > 0 || !result.valid} loading={busy} onClick={() => run(false)}>
              Import {result?.valid ? `${result.valid} staff` : ''}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <button type="button" onClick={() => download('GET', '/staff/import-template')} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
          <FileSpreadsheet className="size-4" /> Download the template
        </button>
        <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 px-4 py-8 text-center hover:border-brand">
          <Upload className="mb-2 size-6 text-slate-400" />
          <span className="text-sm font-medium text-slate-700">{file ? file.name : 'Choose a file'}</span>
          <input
            type="file"
            accept=".xlsx,.csv"
            className="hidden"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
            }}
          />
        </label>
        {result && (
          <div className={result.errors?.length ? 'rounded-lg bg-red-50 p-3' : 'rounded-lg bg-emerald-50 p-3'}>
            {result.imported ? (
              <p className="text-sm font-medium text-emerald-800">Imported {result.imported} staff. A PDF with everyone's login details was downloaded — hand them out and ask staff to change their password.</p>
            ) : result.errors?.length ? (
              <ul className="max-h-48 space-y-1 overflow-y-auto text-xs text-red-700">
                {result.errors.map((e: any, i: number) => (
                  <li key={i}>
                    {e.row ? `Row ${e.row}: ` : ''}
                    {e.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm font-medium text-emerald-800">All {result.valid} rows look good.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ParentLoginsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sections = useSections();
  const [sectionId, setSectionId] = useState('');
  const [sendVia, setSendVia] = useState<string[]>(['whatsapp']);
  const preview = useQuery({ queryKey: ['parent-logins-preview', sectionId], queryFn: () => post<any>('/guardians/portal-accounts/bulk', { sectionId: sectionId || undefined, dryRun: true }), enabled: open });
  const create = useAction(() => post<any>('/guardians/portal-accounts/bulk', { sectionId: sectionId || undefined, sendVia }), {
    success: (r: any) => `Created ${r.created} parent logins${r.messages?.queued ? ` · ${r.messages.queued} messages queued` : ''}`,
    invalidate: [['setup'], ['parent-logins-preview']],
    onSuccess: (r: any) => {
      if (r.slipsPdf) savePdf(r.slipsPdf, 'parent-login-details.pdf');
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create parent app logins"
      description="Each parent signs in with their mobile number and a generated password. You get printable slips, and can also send the details by WhatsApp or SMS."
      footer={
        <Button loading={create.isPending} disabled={!preview.data?.eligible} onClick={() => create.mutate()}>
          Create {preview.data?.eligible ?? ''} logins
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Parents of">
          <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)} placeholder="All classes" options={toOptions(sections.data, (s) => s.label)} />
        </Field>
        <Field label="Also send login details by">
          <div className="flex flex-wrap gap-4 pt-1">
            {[
              ['whatsapp', 'WhatsApp'],
              ['sms', 'SMS'],
              ['email', 'Email'],
            ].map(([c, label]) => (
              <Checkbox key={c} checked={sendVia.includes(c)} onChange={(on) => setSendVia((p) => (on ? [...p, c] : p.filter((x) => x !== c)))} label={label} />
            ))}
          </div>
        </Field>
        {preview.isLoading ? (
          <Loading />
        ) : preview.data ? (
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <p className="font-medium text-slate-800">{preview.data.eligible} parents will get a login.</p>
            {preview.data.skipped.length > 0 && (
              <details className="mt-1 text-slate-600">
                <summary className="cursor-pointer">{preview.data.skipped.length} skipped</summary>
                <ul className="mt-1 max-h-32 overflow-y-auto text-xs">
                  {preview.data.skipped.map((s: any, i: number) => (
                    <li key={i}>
                      {s.name} — {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
