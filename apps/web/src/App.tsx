import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { wasSignedOut, useAuth } from './lib/auth';
import { Loading } from './components/ui';
import { AppShell } from './layout/AppShell';
import { LoginPage } from './pages/auth/LoginPage';

const page = (loader: () => Promise<Record<string, any>>, name: string) => lazy(() => loader().then((m) => ({ default: m[name] })));

const Dashboard = page(() => import('./pages/dashboard/Dashboard'), 'DashboardPage');
const Students = page(() => import('./pages/students/StudentsPage'), 'StudentsPage');
const StudentProfile = page(() => import('./pages/students/StudentProfile'), 'StudentProfilePage');
const Promotion = page(() => import('./pages/students/PromotionPage'), 'PromotionPage');
const Admissions = page(() => import('./pages/admissions/AdmissionsPage'), 'AdmissionsPage');
const ApplicationDetail = page(() => import('./pages/admissions/ApplicationDetail'), 'ApplicationDetailPage');
const Academics = page(() => import('./pages/academics/AcademicsPage'), 'AcademicsPage');
const Staff = page(() => import('./pages/staff/StaffPage'), 'StaffPage');
const Attendance = page(() => import('./pages/attendance/AttendancePage'), 'AttendancePage');
const Fees = page(() => import('./pages/fees/FeesPage'), 'FeesPage');
const StudentFees = page(() => import('./pages/fees/StudentFeesPage'), 'StudentFeesPage');
const Checkout = page(() => import('./pages/fees/CheckoutPage'), 'CheckoutPage');
const Exams = page(() => import('./pages/exams/ExamsPage'), 'ExamsPage');
const ExamDetail = page(() => import('./pages/exams/ExamDetail'), 'ExamDetailPage');
const Timetable = page(() => import('./pages/timetable/TimetablePage'), 'TimetablePage');
const Homework = page(() => import('./pages/homework/HomeworkPage'), 'HomeworkPage');
const HomeworkDetail = page(() => import('./pages/homework/HomeworkDetail'), 'HomeworkDetailPage');
const Announcements = page(() => import('./pages/communication/AnnouncementsPage'), 'AnnouncementsPage');
const Notifications = page(() => import('./pages/communication/NotificationsPage'), 'NotificationsPage');
const Meetings = page(() => import('./pages/meetings/MeetingsPage'), 'MeetingsPage');
const Calendar = page(() => import('./pages/calendar/CalendarPage'), 'CalendarPage');
const Reports = page(() => import('./pages/reports/ReportsPage'), 'ReportsPage');
const Settings = page(() => import('./pages/settings/SettingsPage'), 'SettingsPage');
const PlatformHome = page(() => import('./pages/platform/PlatformHome'), 'PlatformHomePage');
const PlatformSchools = page(() => import('./pages/platform/SchoolsPage'), 'SchoolsPage');
const PlatformSchool = page(() => import('./pages/platform/SchoolDetail'), 'SchoolDetailPage');
const PlatformPlans = page(() => import('./pages/platform/PlansPage'), 'PlansPage');
const Apply = page(() => import('./pages/public/ApplyPage'), 'ApplyPage');

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading className="h-screen" />;
  if (!user) return <Navigate to={wasSignedOut() ? '/login' : `/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

export function App() {
  const { user } = useAuth();
  const platform = !!user?.isPlatformAdmin;
  return (
    <Suspense fallback={<Loading className="h-screen" />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/apply/:slug?" element={<Apply />} />
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          {platform ? (
            <>
              <Route index element={<PlatformHome />} />
              <Route path="platform/schools" element={<PlatformSchools />} />
              <Route path="platform/schools/:id" element={<PlatformSchool />} />
              <Route path="platform/plans" element={<PlatformPlans />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="settings" element={<Settings />} />
            </>
          ) : (
            <>
              <Route index element={<Dashboard />} />
              <Route path="students" element={<Students />} />
              <Route path="students/promote" element={<Promotion />} />
              <Route path="students/:id" element={<StudentProfile />} />
              <Route path="admissions" element={<Admissions />} />
              <Route path="admissions/applications/:id" element={<ApplicationDetail />} />
              <Route path="academics" element={<Academics />} />
              <Route path="staff" element={<Staff />} />
              <Route path="attendance" element={<Attendance />} />
              <Route path="fees" element={<Fees />} />
              <Route path="fees/students/:id" element={<StudentFees />} />
              <Route path="fees/checkout/:id" element={<Checkout />} />
              <Route path="exams" element={<Exams />} />
              <Route path="exams/:id" element={<ExamDetail />} />
              <Route path="timetable" element={<Timetable />} />
              <Route path="homework" element={<Homework />} />
              <Route path="homework/:id" element={<HomeworkDetail />} />
              <Route path="announcements" element={<Announcements />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="meetings" element={<Meetings />} />
              <Route path="calendar" element={<Calendar />} />
              <Route path="reports" element={<Reports />} />
              <Route path="settings" element={<Settings />} />
            </>
          )}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
