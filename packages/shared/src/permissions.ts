/**
 * Permission model.
 *
 * A permission is `<module>.<action>`. Roles hold a list of permissions and a
 * data scope. Permissions decide *what* a user may do; the data scope decides
 * *which records* they may do it to:
 *   - school:   every record in the school
 *   - assigned: records for sections/subjects the user teaches
 *   - own:      the user's own records (a student) or their children's (a parent)
 */

export const MODULES = {
  students: 'Students',
  admissions: 'Admissions',
  academics: 'Classes & Subjects',
  staff: 'Staff',
  attendance: 'Attendance',
  leave: 'Leave',
  fees: 'Fees',
  exams: 'Examinations',
  timetable: 'Timetable',
  homework: 'Homework',
  announcements: 'Announcements',
  meetings: 'Meetings',
  events: 'Events',
  reports: 'Reports',
  certificates: 'Certificates & ID Cards',
  messaging: 'Messaging (WhatsApp/SMS/Email)',
  settings: 'School Settings',
  users: 'Users & Roles',
} as const;

export type ModuleKey = keyof typeof MODULES;

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export'] as const;
export type Action = (typeof ACTIONS)[number];

export type Permission = `${ModuleKey}.${Action}`;

export const ALL_PERMISSIONS: Permission[] = (Object.keys(MODULES) as ModuleKey[]).flatMap((m) =>
  ACTIONS.map((a) => `${m}.${a}` as Permission),
);

export const DATA_SCOPES = ['school', 'assigned', 'own'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

export const SYSTEM_ROLES = ['school_admin', 'principal', 'teacher', 'accountant', 'student', 'parent'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLES)[number];

const p = (module: ModuleKey, actions: Action[] | '*'): Permission[] =>
  (actions === '*' ? [...ACTIONS] : actions).map((a) => `${module}.${a}` as Permission);

export const DEFAULT_ROLES: Record<SystemRoleKey, { name: string; scope: DataScope; permissions: Permission[] }> = {
  school_admin: { name: 'School Admin', scope: 'school', permissions: ALL_PERMISSIONS },
  principal: {
    name: 'Principal',
    scope: 'school',
    permissions: [
      ...p('students', '*'),
      ...p('admissions', '*'),
      ...p('academics', '*'),
      ...p('staff', ['view', 'export']),
      ...p('attendance', '*'),
      ...p('leave', '*'),
      ...p('fees', ['view', 'export']),
      ...p('exams', '*'),
      ...p('timetable', '*'),
      ...p('homework', ['view', 'export']),
      ...p('announcements', '*'),
      ...p('meetings', '*'),
      ...p('events', '*'),
      ...p('reports', ['view', 'export']),
      ...p('certificates', '*'),
      ...p('messaging', ['view', 'create']),
      ...p('settings', ['view']),
      ...p('users', ['view']),
    ],
  },
  teacher: {
    name: 'Teacher',
    scope: 'assigned',
    permissions: [
      ...p('students', ['view']),
      ...p('academics', ['view']),
      ...p('attendance', ['view', 'create', 'edit']),
      ...p('leave', ['view', 'create', 'approve']),
      ...p('exams', ['view', 'create', 'edit']),
      ...p('timetable', ['view']),
      ...p('homework', ['view', 'create', 'edit', 'delete']),
      ...p('announcements', ['view', 'create']),
      ...p('meetings', ['view', 'create', 'edit', 'approve']),
      ...p('events', ['view']),
      ...p('reports', ['view', 'export']),
    ],
  },
  accountant: {
    name: 'Accountant',
    scope: 'school',
    permissions: [
      ...p('students', ['view']),
      ...p('academics', ['view']),
      ...p('fees', '*'),
      ...p('messaging', ['view', 'create']),
      ...p('announcements', ['view']),
      ...p('events', ['view']),
      ...p('reports', ['view', 'export']),
    ],
  },
  student: {
    name: 'Student',
    scope: 'own',
    permissions: [
      ...p('attendance', ['view']),
      ...p('leave', ['view', 'create']),
      ...p('fees', ['view']),
      ...p('exams', ['view']),
      ...p('timetable', ['view']),
      ...p('homework', ['view']),
      ...p('announcements', ['view']),
      ...p('events', ['view']),
    ],
  },
  parent: {
    name: 'Parent',
    scope: 'own',
    permissions: [
      ...p('students', ['view']),
      ...p('attendance', ['view']),
      ...p('leave', ['view', 'create']),
      ...p('fees', ['view']),
      ...p('exams', ['view']),
      ...p('timetable', ['view']),
      ...p('homework', ['view']),
      ...p('announcements', ['view']),
      ...p('meetings', ['view', 'create']),
      ...p('events', ['view']),
    ],
  },
};

/** Subscription-gated product features. Plans enable a subset; schools can be overridden. */
export const FEATURES = {
  admissions: 'Admissions',
  attendance: 'Attendance',
  fees: 'Fee Management',
  exams: 'Examinations',
  timetable: 'Timetable',
  homework: 'Homework',
  communication: 'Announcements & Notifications',
  meetings: 'Meetings',
  events: 'Events & Calendar',
  reports: 'Reports & Analytics',
  online_payments: 'Online Payments',
  messaging: 'WhatsApp, SMS & Email Delivery',
  certificates: 'Certificates & ID Cards',
  custom_domain: 'Custom Subdomain',
} as const;
export type FeatureKey = keyof typeof FEATURES;
export const ALL_FEATURES = Object.keys(FEATURES) as FeatureKey[];
