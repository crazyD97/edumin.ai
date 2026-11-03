/** File list + upload for any entity (student, application, assignment, submission). */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { del, get, upload } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Button, EmptyState, Spinner, confirm } from './ui';

interface FileRow {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  category: string | null;
  createdAt: string;
  url: string;
}

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export function Documents({ entity, entityId, canUpload = true, canDelete = true, compact }: { entity: string; entityId: string; canUpload?: boolean; canDelete?: boolean; compact?: boolean }) {
  const qc = useQueryClient();
  const key = ['files', entity, entityId];
  const q = useQuery({ queryKey: key, queryFn: () => get<FileRow[]>('/files', { entity, entityId }) });
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState('');

  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      await upload(file, { entity, entityId, ...(category ? { category } : {}) });
      toast.success('File uploaded');
      setCategory('');
      qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (f: FileRow) => {
    if (!(await confirm({ title: `Delete ${f.filename}?`, danger: true, confirmLabel: 'Delete' }))) return;
    await del(`/files/${f.id}`);
    qc.invalidateQueries({ queryKey: key });
  };

  return (
    <div>
      {canUpload && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          {!compact && <input className="input sm:max-w-56" placeholder="Label (e.g. Birth certificate)" value={category} onChange={(e) => setCategory(e.target.value)} />}
          <label className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            {busy ? <Spinner className="size-4" /> : <Upload className="size-4" />} {busy ? 'Uploading…' : 'Upload file'}
            <input type="file" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} disabled={busy} />
          </label>
          <span className="text-xs text-slate-500">PDF, images, Word or Excel · max 10 MB</span>
        </div>
      )}
      {q.isLoading ? (
        <Spinner />
      ) : q.data?.length ? (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {q.data.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2.5">
              <FileText className="size-4 shrink-0 text-slate-400" />
              <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 hover:text-brand-700">
                {f.category ? `${f.category} — ` : ''}
                {f.filename}
              </a>
              <span className="hidden text-xs text-slate-500 sm:inline">
                {kb(f.size)} · {fmtDate(f.createdAt)}
              </span>
              {canDelete && (
                <Button size="sm" variant="ghost" onClick={() => remove(f)} aria-label="Delete file">
                  <Trash2 className="size-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        !compact && <EmptyState icon={<Paperclip className="size-5" />} title="No documents" description="Uploaded files will appear here." />
      )}
    </div>
  );
}
