import { Suspense, useEffect, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  CalendarDays,
  CalendarClock,
  ClipboardCheck,
  CreditCard,
  GraduationCap,
  Handshake,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu as MenuIcon,
  NotebookPen,
  Package,
  School,
  Settings,
  UserPlus,
  Users,
  UserSquare2,
  X,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { post } from '@/lib/api';
import { ago } from '@/lib/format';
import { Avatar, Loading, Menu, MenuItem, clsx } from '@/components/ui';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  perm?: string;
  feature?: string;
  /** Override the label for students/parents. */
  familyLabel?: string;
  staffOnly?: boolean;
}

const SCHOOL_NAV: { group: string; items: NavItem[] }[] = [
  {
    group: '',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/calendar', label: 'Calendar', icon: CalendarDays },
    ],
  },
  {
    group: 'Academics',
    items: [
      { to: '/students', label: 'Students', icon: GraduationCap, perm: 'students.view', staffOnly: true },
      { to: '/admissions', label: 'Admissions', icon: UserPlus, perm: 'admissions.view', feature: 'admissions' },
      { to: '/academics', label: 'Classes & Subjects', icon: School, perm: 'academics.view', staffOnly: true },
      { to: '/attendance', label: 'Attendance', icon: ClipboardCheck, perm: 'attendance.view', feature: 'attendance' },
      { to: '/exams', label: 'Examinations', icon: BookOpen, perm: 'exams.view', feature: 'exams', familyLabel: 'Results' },
      { to: '/timetable', label: 'Timetable', icon: CalendarClock, perm: 'timetable.view', feature: 'timetable' },
      { to: '/homework', label: 'Homework', icon: NotebookPen, perm: 'homework.view', feature: 'homework' },
    ],
  },
  { group: 'Finance', items: [{ to: '/fees', label: 'Fees', icon: CreditCard, perm: 'fees.view', feature: 'fees' }] },
  {
    group: 'Communication',
    items: [
      { to: '/announcements', label: 'Announcements', icon: Megaphone, perm: 'announcements.view', feature: 'communication' },
      { to: '/meetings', label: 'Meetings', icon: Handshake, perm: 'meetings.view', feature: 'meetings' },
    ],
  },
  {
    group: 'Administration',
    items: [
      { to: '/staff', label: 'Staff', icon: UserSquare2, perm: 'staff.view' },
      { to: '/reports', label: 'Reports', icon: BarChart3, perm: 'reports.view', feature: 'reports' },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

const PLATFORM_NAV: { group: string; items: NavItem[] }[] = [
  {
    group: '',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard },
      { to: '/platform/schools', label: 'Schools', icon: Building2 },
      { to: '/platform/plans', label: 'Plans', icon: Package },
      { to: '/settings', label: 'Account', icon: Settings },
    ],
  },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user, school, can, hasFeature } = useAuth();
  const family = user?.role.scope === 'own';
  const nav = user?.isPlatformAdmin ? PLATFORM_NAV : SCHOOL_NAV;
  const logo = school?.branding.logoUrl;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2.5 px-4">
        {logo ? (
          <img src={logo} alt="" className="size-8 rounded-lg object-contain" />
        ) : (
          <span className="grid size-8 place-items-center rounded-lg bg-brand text-sm font-bold text-white">{(school?.name ?? 'E')[0]}</span>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{user?.isPlatformAdmin ? 'Edumin Platform' : school?.name}</p>
          <p className="truncate text-xs text-slate-500">{user?.role.name}</p>
        </div>
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {nav.map((g) => {
          const items = g.items.filter((i) => (!i.perm || can(i.perm)) && (!i.feature || hasFeature(i.feature)) && !(i.staffOnly && family));
          if (!items.length) return null;
          return (
            <div key={g.group || 'main'}>
              {g.group && <p className="mb-1 px-2.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{g.group}</p>}
              <div className="space-y-0.5">
                {items.map((i) => (
                  <NavLink
                    key={i.to}
                    to={i.to}
                    end={i.to === '/'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      clsx('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition', isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')
                    }
                  >
                    <i.icon className="size-4 shrink-0" />
                    {family && i.familyLabel ? i.familyLabel : i.label}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
      {school?.status === 'trial' && school.trialEndsAt && (
        <div className="m-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          Trial ends <b>{ago(school.trialEndsAt)}</b>
        </div>
      )}
    </div>
  );
}

interface Notification {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

function NotificationBell() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['notifications', 'bell'],
    queryFn: async () => {
      const res = await fetch('/api/notifications?limit=8', { credentials: 'include' });
      const j = await res.json();
      return { rows: j.data as Notification[], unread: j.unreadCount as number };
    },
    refetchInterval: 60_000,
  });
  const markRead = async (ids?: string[]) => {
    await post('/notifications/read', { ids });
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return (
    <Menu
      trigger={
        <button type="button" className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800" aria-label="Notifications">
          <Bell className="size-5" />
          {!!q.data?.unread && <span className="absolute top-1 right-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">{q.data.unread > 9 ? '9+' : q.data.unread}</span>}
        </button>
      }
    >
      {(close) => (
        <div className="w-[min(22rem,90vw)]">
          <div className="flex items-center justify-between px-2.5 py-2">
            <p className="text-sm font-semibold">Notifications</p>
            {!!q.data?.unread && (
              <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => markRead()}>
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {q.data?.rows.length ? (
              q.data.rows.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className="flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-slate-50"
                  onClick={() => {
                    if (!n.readAt) markRead([n.id]);
                    close();
                    if (n.link) navigate(n.link);
                  }}
                >
                  <span className={clsx('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brand')} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-800">{n.title}</span>
                    {n.body && <span className="line-clamp-2 block text-xs text-slate-500">{n.body}</span>}
                    <span className="mt-0.5 block text-[11px] text-slate-400">{ago(n.createdAt)}</span>
                  </span>
                </button>
              ))
            ) : (
              <p className="px-3 py-8 text-center text-sm text-slate-400">You're all caught up</p>
            )}
          </div>
          <button
            className="mt-1 w-full rounded-lg border-t border-slate-100 py-2 text-center text-xs font-medium text-slate-600 hover:bg-slate-50"
            onClick={() => {
              close();
              navigate('/notifications');
            }}
          >
            View all
          </button>
        </div>
      )}
    </Menu>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [loc.pathname]);

  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-slate-200 bg-white lg:block">
        <Sidebar />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-white shadow-xl">
            <button className="absolute top-4 right-3 rounded-md p-1 text-slate-400" onClick={() => setOpen(false)} aria-label="Close menu">
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <header className="no-print sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur sm:px-6">
        <button className="-ml-1 rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
          <MenuIcon className="size-5" />
        </button>
        <div className="flex-1" />
        <NotificationBell />
        <Menu
          trigger={
            <button type="button" className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-slate-100">
              <Avatar name={user?.fullName} src={user?.avatarUrl} size={30} />
              <span className="hidden text-left sm:block">
                <span className="block max-w-40 truncate text-sm leading-tight font-medium text-slate-800">{user?.fullName}</span>
                <span className="block max-w-40 truncate text-xs leading-tight text-slate-500">{user?.email}</span>
              </span>
            </button>
          }
        >
          {(close) => (
            <>
              <MenuItem
                icon={<Users className="size-4" />}
                onClick={() => {
                  close();
                  navigate('/settings?tab=profile');
                }}
              >
                My profile
              </MenuItem>
              <MenuItem
                danger
                icon={<LogOut className="size-4" />}
                onClick={async () => {
                  close();
                  await logout(); // RequireAuth then redirects to /login
                }}
              >
                Sign out
              </MenuItem>
            </>
          )}
        </Menu>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
