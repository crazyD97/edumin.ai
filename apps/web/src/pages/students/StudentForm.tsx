import { useEffect, useState } from 'react';
import { Plus, Trash2, Upload } from 'lucide-react';
import { GENDERS } from '@edumin/shared';
import { ApiError, post, put, upload } from '@/lib/api';
import { useAction, useSections, toOptions } from '@/lib/hooks';
import { Avatar, Button, Checkbox, Field, Input, Modal, Select, Textarea } from '@/components/ui';

interface Guardian {
  id?: string;
  name: string;
  relation: string;
  phone: string;
  email: string;
  occupation: string;
  isPrimary: boolean;
}

const blankGuardian = (): Guardian => ({ name: '', relation: 'father', phone: '', email: '', occupation: '', isPrimary: false });

const EMPTY = {
  admissionNo: '',
  firstName: '',
  lastName: '',
  dateOfBirth: '',
  gender: '',
  bloodGroup: '',
  photoUrl: '',
  email: '',
  phone: '',
  address: '',
  nationality: '',
  religion: '',
  previousSchool: '',
  medicalNotes: '',
  admissionDate: '',
  sectionId: '',
  rollNo: '',
};

export function StudentFormModal({ open, onClose, student, onSaved }: { open: boolean; onClose: () => void; student?: any; onSaved?: (id: string) => void }) {
  const sections = useSections();
  const [f, setF] = useState({ ...EMPTY });
  const [guardians, setGuardians] = useState<Guardian[]>([{ ...blankGuardian(), isPrimary: true }]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (student) {
      const s: any = { ...EMPTY };
      for (const k of Object.keys(EMPTY)) s[k] = student[k] ?? '';
      s.sectionId = student.current?.sectionId ?? '';
      s.rollNo = student.current?.rollNo ?? '';
      setF(s);
      setGuardians(student.guardians?.length ? student.guardians.map((g: any) => ({ ...blankGuardian(), ...Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v ?? ''])) })) : [{ ...blankGuardian(), isPrimary: true }]);
    } else {
      setF({ ...EMPTY });
      setGuardians([{ ...blankGuardian(), isPrimary: true }]);
    }
  }, [open, student]);

  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const setG = (i: number, patch: Partial<Guardian>) => setGuardians((gs) => gs.map((g, j) => (j === i ? { ...g, ...patch } : patch.isPrimary ? { ...g, isPrimary: false } : g)));

  const save = useAction(
    () => {
      const body = { ...f, rollNo: f.rollNo ? Number(f.rollNo) : null, guardians: guardians.filter((g) => g.name.trim()) };
      return student ? put(`/students/${student.id}`, body).then(() => ({ id: student.id })) : post<{ id: string; admissionNo: string }>('/students', body);
    },
    {
      success: (r: any) => (student ? 'Student updated' : `Student registered · ${r.admissionNo}`),
      invalidate: [['students'], ['student'], ['sections']],
      onSuccess: (r: any) => {
        onSaved?.(r.id);
        onClose();
      },
      onError: (e: ApiError) => setErrors(e.fieldErrors),
    },
  );

  const onPhoto = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      const r = await upload(file, { entity: 'avatar' });
      setF((p) => ({ ...p, photoUrl: r.url }));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={student ? 'Edit student' : 'Register student'}
      description={student ? `${student.firstName} ${student.lastName} · ${student.admissionNo}` : 'Admission number is generated automatically if left blank.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            {student ? 'Save changes' : 'Register student'}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <section>
          <h4 className="mb-3 text-xs font-semibold tracking-wider text-slate-500 uppercase">Student</h4>
          <div className="mb-4 flex items-center gap-4">
            <Avatar name={`${f.firstName} ${f.lastName}`} src={f.photoUrl || null} size={56} />
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              <Upload className="size-4" /> {uploading ? 'Uploading…' : 'Upload photo'}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => onPhoto(e.target.files?.[0])} />
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="First name" required error={errors.firstName}>
              <Input value={f.firstName} onChange={set('firstName')} invalid={!!errors.firstName} />
            </Field>
            <Field label="Last name" error={errors.lastName}>
              <Input value={f.lastName} onChange={set('lastName')} />
            </Field>
            <Field label="Admission no." hint="Auto-generated if blank" error={errors.admissionNo}>
              <Input value={f.admissionNo} onChange={set('admissionNo')} />
            </Field>
            <Field label="Date of birth" error={errors.dateOfBirth}>
              <Input type="date" value={f.dateOfBirth} onChange={set('dateOfBirth')} />
            </Field>
            <Field label="Gender">
              <Select value={f.gender} onChange={set('gender')} placeholder="Select" options={GENDERS.map((g) => ({ value: g, label: g[0].toUpperCase() + g.slice(1) }))} />
            </Field>
            <Field label="Blood group">
              <Select value={f.bloodGroup} onChange={set('bloodGroup')} placeholder="Select" options={['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((v) => ({ value: v, label: v }))} />
            </Field>
            <Field label="Phone">
              <Input value={f.phone} onChange={set('phone')} />
            </Field>
            <Field label="Email" error={errors.email}>
              <Input type="email" value={f.email} onChange={set('email')} invalid={!!errors.email} />
            </Field>
            <Field label="Admission date">
              <Input type="date" value={f.admissionDate} onChange={set('admissionDate')} />
            </Field>
            <Field label="Address" className="sm:col-span-3">
              <Textarea rows={2} value={f.address} onChange={set('address')} />
            </Field>
            <Field label="Nationality">
              <Input value={f.nationality} onChange={set('nationality')} />
            </Field>
            <Field label="Religion">
              <Input value={f.religion} onChange={set('religion')} />
            </Field>
            <Field label="Previous school">
              <Input value={f.previousSchool} onChange={set('previousSchool')} />
            </Field>
            <Field label="Medical notes" className="sm:col-span-3">
              <Textarea rows={2} value={f.medicalNotes} onChange={set('medicalNotes')} placeholder="Allergies, conditions, medication…" />
            </Field>
          </div>
        </section>

        <section>
          <h4 className="mb-3 text-xs font-semibold tracking-wider text-slate-500 uppercase">Class allocation (current year)</h4>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Class & section" className="sm:col-span-2">
              <Select value={f.sectionId} onChange={set('sectionId')} placeholder="Not allocated" options={toOptions(sections.data, (s) => s.label)} />
            </Field>
            <Field label="Roll no." hint="Next available if blank">
              <Input type="number" min={1} value={f.rollNo} onChange={set('rollNo')} />
            </Field>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">Parents & guardians</h4>
            <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setGuardians((g) => [...g, blankGuardian()])}>
              Add guardian
            </Button>
          </div>
          <div className="space-y-3">
            {guardians.map((g, i) => (
              <div key={i} className="rounded-lg border border-slate-200 p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Name" error={errors[`guardians.${i}.name`]}>
                    <Input value={g.name} onChange={(e) => setG(i, { name: e.target.value })} />
                  </Field>
                  <Field label="Relation">
                    <Select value={g.relation} onChange={(e) => setG(i, { relation: e.target.value })} options={['father', 'mother', 'guardian', 'grandparent', 'sibling', 'other'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} />
                  </Field>
                  <Field label="Phone">
                    <Input value={g.phone} onChange={(e) => setG(i, { phone: e.target.value })} />
                  </Field>
                  <Field label="Email" error={errors[`guardians.${i}.email`]}>
                    <Input type="email" value={g.email} onChange={(e) => setG(i, { email: e.target.value })} />
                  </Field>
                  <Field label="Occupation">
                    <Input value={g.occupation} onChange={(e) => setG(i, { occupation: e.target.value })} />
                  </Field>
                  <div className="flex items-end justify-between gap-2 pb-2">
                    <Checkbox checked={g.isPrimary} onChange={(v) => setG(i, { isPrimary: v })} label="Primary contact" />
                    {guardians.length > 1 && (
                      <button type="button" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => setGuardians((gs) => gs.filter((_, j) => j !== i))} aria-label="Remove guardian">
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">Siblings share guardian records automatically when the name and email or phone match.</p>
        </section>
      </div>
    </Modal>
  );
}
