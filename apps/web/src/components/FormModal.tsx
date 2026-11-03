/**
 * Config-driven form in a modal. Handles field rendering, server-side
 * validation errors and submit state, so simple CRUD screens stay small.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, clsx, type Option } from './ui';

export interface FieldDef {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'number' | 'date' | 'time' | 'datetime-local' | 'password' | 'select' | 'textarea' | 'checkbox' | 'color';
  options?: Option[];
  placeholder?: string;
  required?: boolean;
  hint?: ReactNode;
  span?: 1 | 2;
  hidden?: (values: Record<string, any>) => boolean;
  step?: string;
}

export function FormModal({
  open,
  onClose,
  title,
  description,
  fields,
  initial,
  submit,
  submitLabel = 'Save',
  success,
  invalidate,
  onSaved,
  size = 'md',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  fields: FieldDef[];
  initial?: Record<string, any>;
  submit: (values: Record<string, any>) => Promise<any>;
  submitLabel?: string;
  success?: string;
  invalidate?: unknown[][];
  onSaved?: (r: any) => void;
  size?: 'sm' | 'md' | 'lg';
  children?: (values: Record<string, any>, set: (k: string, v: any) => void) => ReactNode;
}) {
  const [values, setValues] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      const defaults = Object.fromEntries(fields.map((f) => [f.name, f.type === 'checkbox' ? false : '']));
      const given = Object.fromEntries(Object.entries(initial ?? {}).filter(([, v]) => v !== null && v !== undefined));
      setValues({ ...defaults, ...given });
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: string, v: any) => setValues((p) => ({ ...p, [k]: v }));
  const save = useAction(() => submit(values), {
    success,
    invalidate,
    onSuccess: (r) => {
      onClose();
      onSaved?.(r);
    },
    onError: (e: ApiError) => setErrors(e.fieldErrors),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size={size}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="grid gap-4 sm:grid-cols-2"
      >
        {fields
          .filter((f) => !f.hidden?.(values))
          .map((f) => (
            <Field key={f.name} label={f.type === 'checkbox' ? undefined : f.label} required={f.required} error={errors[f.name]} hint={f.hint} className={clsx(f.span !== 1 && 'sm:col-span-2')}>
              {f.type === 'select' ? (
                <Select value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)} options={f.options ?? []} placeholder={f.placeholder ?? (f.required ? undefined : '—')} />
              ) : f.type === 'textarea' ? (
                <Textarea value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} />
              ) : f.type === 'checkbox' ? (
                <Checkbox checked={!!values[f.name]} onChange={(v) => set(f.name, v)} label={f.label} />
              ) : f.type === 'color' ? (
                <div className="flex items-center gap-2">
                  <input type="color" value={values[f.name] || '#000000'} onChange={(e) => set(f.name, e.target.value)} className="h-9 w-12 cursor-pointer rounded border border-slate-300" />
                  <Input value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)} />
                </div>
              ) : (
                <Input type={f.type ?? 'text'} step={f.step} value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} invalid={!!errors[f.name]} />
              )}
            </Field>
          ))}
        {children?.(values, set)}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}
