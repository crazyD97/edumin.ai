/** Ctrl/⌘+K: search students, staff, receipts… and jump to any page. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeft, FileText, GraduationCap, Receipt, Search, UserPlus, UserSquare2, Award, ArrowRight } from 'lucide-react';
import { get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounced } from '@/lib/hooks';
import { clsx } from './ui';

interface Item {
  key: string;
  title: string;
  subtitle?: string;
  link: string;
  group: string;
  icon: typeof Search;
}

const PAGES: { title: string; link: string; perm?: string; feature?: string; keywords?: string }[] = [
  { title: 'Dashboard', link: '/' },
  { title: 'Students', link: '/students', perm: 'students.view' },
  { title: 'Add a student', link: '/students?new=1', perm: 'students.create', keywords: 'register admission' },
  { title: 'Mark attendance', link: '/attendance', perm: 'attendance.create', feature: 'attendance' },
  { title: 'Collect fees', link: '/fees', perm: 'fees.create', feature: 'fees', keywords: 'payment receipt' },
  { title: 'Fee dues & invoices', link: '/fees?tab=invoices', perm: 'fees.view', feature: 'fees', keywords: 'defaulters pending' },
  { title: 'Examinations & results', link: '/exams', perm: 'exams.view', feature: 'exams', keywords: 'marks report card' },
  { title: 'Timetable', link: '/timetable', perm: 'timetable.view', feature: 'timetable' },
  { title: 'Homework', link: '/homework', perm: 'homework.view', feature: 'homework' },
  { title: 'Admissions', link: '/admissions', perm: 'admissions.view', feature: 'admissions', keywords: 'enquiry application' },
  { title: 'Announcements', link: '/announcements', perm: 'announcements.view', feature: 'communication' },
  { title: 'WhatsApp & SMS', link: '/messaging', perm: 'messaging.view', keywords: 'credits messages' },
  { title: 'Certificates & ID cards', link: '/certificates', perm: 'certificates.view', feature: 'certificates', keywords: 'tc bonafide transfer' },
  { title: 'Reports', link: '/reports', perm: 'reports.view', feature: 'reports' },
  { title: 'Calendar', link: '/calendar' },
  { title: 'Staff', link: '/staff', perm: 'staff.view' },
  { title: 'Setup checklist', link: '/setup', perm: 'settings.view', keywords: 'onboarding wizard' },
  { title: 'Settings', link: '/settings' },
];

const GROUP_ICON: Record<string, typeof Search> = { student: GraduationCap, staff: UserSquare2, receipt: Receipt, application: UserPlus, certificate: Award };

export function CommandPalette() {
  const { user, can, hasFeature } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dq = useDebounced(q, 200);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('edumin:search', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('edumin:search', onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);

  const results = useQuery({ queryKey: ['search', dq], queryFn: () => get<any[]>('/search', { q: dq }), enabled: open && dq.length >= 2 && !!user?.school });
  const items: Item[] = useMemo(() => {
    const term = q.trim().toLowerCase();
    const pages = PAGES.filter((p) => (!p.perm || can(p.perm)) && (!p.feature || hasFeature(p.feature)))
      .filter((p) => !term || `${p.title} ${p.keywords ?? ''}`.toLowerCase().includes(term))
      .slice(0, term ? 5 : 8)
      .map((p) => ({ key: `page:${p.link}`, title: p.title, link: p.link, group: 'Go to', icon: ArrowRight }));
    const found = (term.length >= 2 ? (results.data ?? []) : []).flatMap((g) => g.items.map((i: any) => ({ key: `${g.type}:${i.id}`, title: i.title, subtitle: i.subtitle, link: i.link, group: g.label, icon: GROUP_ICON[g.type] ?? FileText })));
    return [...found, ...pages];
  }, [q, results.data, can, hasFeature]);
  useEffect(() => setActive(0), [items.length]);

  if (!open || user?.isPlatformAdmin) return null;
  const go = (i: Item) => {
    setOpen(false);
    navigate(i.link);
  };
  let lastGroup = '';
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" />
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-slate-100 px-4">
          <Search className="size-5 text-slate-400" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, items.length - 1)));
              if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
              if (e.key === 'Enter' && items[active]) go(items[active]);
              if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="Search students, parents' phone, staff, receipts… or jump to a page"
            className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-slate-400"
          />
          <kbd className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-400">Esc</kbd>
        </div>
        <ul className="max-h-[55vh] overflow-y-auto p-2">
          {items.map((i, idx) => {
            const header = i.group !== lastGroup ? i.group : null;
            lastGroup = i.group;
            return (
              <li key={i.key}>
                {header && <p className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{header}</p>}
                <button
                  type="button"
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => go(i)}
                  className={clsx('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left', idx === active ? 'bg-brand-50' : 'hover:bg-slate-50')}
                >
                  <i.icon className={clsx('size-4 shrink-0', idx === active ? 'text-brand' : 'text-slate-400')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">{i.title}</span>
                    {i.subtitle && <span className="block truncate text-xs text-slate-500">{i.subtitle}</span>}
                  </span>
                  {idx === active && <CornerDownLeft className="size-3.5 text-slate-400" />}
                </button>
              </li>
            );
          })}
          {!items.length && <li className="px-3 py-8 text-center text-sm text-slate-400">{results.isFetching ? 'Searching…' : 'No matches'}</li>}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
