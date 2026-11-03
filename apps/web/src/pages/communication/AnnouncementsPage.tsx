import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Megaphone, Pin, PinOff, Plus, Trash2, Users } from 'lucide-react';
import { ANNOUNCEMENT_AUDIENCES, ANNOUNCEMENT_CATEGORIES } from '@edumin/shared';
import { apiPage, del, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useClasses, useDebounced, useSections } from '@/lib/hooks';
import { ago, titleCase } from '@/lib/format';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Textarea, confirm, type Tone } from '@/components/ui';
import { Pager, Toolbar } from '@/components/DataTable';

const CAT_TONE: Record<string, Tone> = { general: 'gray', exam: 'violet', event: 'blue', fee: 'amber', attendance: 'red', holiday: 'green' };

export function AnnouncementsPage() {
  const { can, user } = useAuth();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);
  const q = useDebounced(search);
  const params = { search: q, category, page, pageSize: 15 };
  const list = useQuery({ queryKey: ['announcements', params], queryFn: () => apiPage('/announcements', params), placeholderData: keepPreviousData });
  const pin = useAction(({ id, isPinned }: { id: string; isPinned: boolean }) => patch(`/announcements/${id}`, { isPinned }), { invalidate: [['announcements']] });
  const remove = useAction((id: string) => del(`/announcements/${id}`), { success: 'Announcement deleted', invalidate: [['announcements']] });
  return (
    <>
      <PageHeader
        title="Announcements"
        description="School-wide and class notices. Recipients get an in-app notification (and email if selected)."
        actions={
          can('announcements.create') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setComposing(true)}>
              New announcement
            </Button>
          )
        }
      />
      <Card padded={false}>
        <Toolbar search={search} onSearch={setSearch}>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} placeholder="All categories" options={ANNOUNCEMENT_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} />
        </Toolbar>
        {list.isLoading ? (
          <Loading />
        ) : list.data?.rows.length ? (
          <ul className="divide-y divide-slate-100">
            {list.data.rows.map((a: any) => (
              <li key={a.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      {a.isPinned && <Pin className="size-3.5 text-brand" />}
                      <h3 className="font-semibold text-slate-900">{a.title}</h3>
                      <Badge tone={CAT_TONE[a.category]}>{titleCase(a.category)}</Badge>
                      <Badge>
                        <Users className="size-3" /> {a.audience === 'classes' ? `${a.classIds.length} class(es)` : titleCase(a.audience)}
                      </Badge>
                    </div>
                    <p className="text-sm whitespace-pre-wrap text-slate-600">{a.body}</p>
                    <p className="mt-2 text-xs text-slate-400">
                      {a.authorName} · {ago(a.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {can('announcements.edit') && (
                      <Button size="sm" variant="ghost" onClick={() => pin.mutate({ id: a.id, isPinned: !a.isPinned })} aria-label={a.isPinned ? 'Unpin' : 'Pin'}>
                        {a.isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                      </Button>
                    )}
                    {(can('announcements.delete') || a.createdBy === user?.id) && (
                      <Button size="sm" variant="ghost" onClick={async () => (await confirm({ title: 'Delete announcement?', danger: true })) && remove.mutate(a.id)} aria-label="Delete">
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<Megaphone className="size-5" />} title="No announcements" />
        )}
        {list.data && <Pager page={page} pageSize={15} total={list.data.meta.total} onPage={setPage} />}
      </Card>
      <Composer open={composing} onClose={() => setComposing(false)} />
    </>
  );
}

function Composer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const classes = useClasses();
  const sections = useSections();
  const teacher = user?.role.scope !== 'school';
  const myClassIds = new Set(sections.data?.map((s) => s.classId));
  const classOptions = (classes.data ?? []).filter((c) => !teacher || myClassIds.has(c.id));
  const [f, setF] = useState({ title: '', body: '', category: 'general', audience: teacher ? 'classes' : 'all', classIds: [] as string[], isPinned: false, sendEmail: false });
  const save = useAction(() => post<any>('/announcements', f), {
    success: (r: any) => `Announcement sent to ${r.recipients} people`,
    invalidate: [['announcements']],
    onSuccess: () => {
      setF({ ...f, title: '', body: '', classIds: [] });
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="New announcement"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!f.title || !f.body || (f.audience === 'classes' && !f.classIds.length)} onClick={() => save.mutate()}>
            Publish
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" className="sm:col-span-2" required>
          <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Category">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} options={ANNOUNCEMENT_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} />
        </Field>
        <Field label="Audience">
          <Select value={f.audience} disabled={teacher} onChange={(e) => setF({ ...f, audience: e.target.value })} options={ANNOUNCEMENT_AUDIENCES.map((a) => ({ value: a, label: a === 'classes' ? 'Specific classes' : a === 'all' ? 'Everyone' : `All ${a}` }))} />
        </Field>
        {f.audience === 'classes' && (
          <Field label="Classes" className="sm:col-span-2" hint="Students, their parents and class teachers are notified.">
            <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border border-slate-200 p-3">
              {classOptions.map((c) => (
                <Checkbox key={c.id} checked={f.classIds.includes(c.id)} onChange={(on) => setF({ ...f, classIds: on ? [...f.classIds, c.id] : f.classIds.filter((x) => x !== c.id) })} label={c.name} />
              ))}
            </div>
          </Field>
        )}
        <Field label="Message" className="sm:col-span-2" required>
          <Textarea rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </Field>
        <div className="flex flex-wrap gap-6 sm:col-span-2">
          <Checkbox checked={f.sendEmail} onChange={(v) => setF({ ...f, sendEmail: v })} label="Also send by email" />
          {!teacher && <Checkbox checked={f.isPinned} onChange={(v) => setF({ ...f, isPinned: v })} label="Pin to top" />}
        </div>
      </div>
    </Modal>
  );
}
