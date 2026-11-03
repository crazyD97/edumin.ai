# Implementation checklist

✅ = built, connected to the database and exercised (tests and/or browser) · ⚠️ = built with a noted limitation · ⏭️ = deliberately left for later

## Phase 1 — Foundation
- ✅ Monorepo (API, web, shared), TypeScript end to end
- ✅ PostgreSQL schema (~40 tables), Drizzle migrations
- ✅ Authentication (bcrypt, JWT cookie or bearer, token revocation, rate limiting)
- ✅ Multi-tenancy: per-school data, school-scoped logins, subdomain resolution, suspend/trial blocking
- ✅ RBAC: 6 default roles + custom roles, 16 modules × 6 actions, data scope (school/assigned/own), editable permission matrix
- ✅ Branding: name, logo, favicon, 3 colours, contact, website, login page, report-card and receipt texts; applied live in the UI and on PDFs
- ✅ Super admin: onboard schools, activate/suspend, plans CRUD, feature overrides, usage, trials, subscription status, manual payments ledger, platform stats

## Phase 2 — Core operations
- ✅ Students: registration, profiles, photos, guardians (shared by siblings), documents, status, academic history, search/filters, Excel/CSV import with validation, export, portal logins
- ✅ Promotion between years (promote/retain/graduate/leave), transfer & withdrawal
- ✅ Admissions: public enquiry & application forms (with document upload), status tracking, review, approve/reject, enrol → student with generated admission number
- ✅ Academic structure: years, classes, sections, subjects, class/subject teachers, copy structure to a new year
- ✅ Attendance: quick bulk marking (P/A/L/H), monthly register, percentages, low-attendance list + alerts, absence alerts to parents, staff attendance, leave apply/approve, parent visibility
- ✅ Fees: heads, class or student fee structures, monthly/quarterly/annual installments, idempotent invoice generation, discounts & scholarships, late fees, partial payments, allocations, receipts (PDF), dues, defaulters, reminders
- ⚠️ Online payments: gateway interface + mock checkout; a real provider (Razorpay/Stripe) still has to be implemented

## Phase 3 — Academic operations
- ✅ Exams: creation, per-class schedule, configurable grading scales, marks entry (teacher-restricted), pass/fail, percentage, grade, competition ranks (class & section), subject analysis, approval/publish (locks marks), PDF report cards (single or whole section), historical records
- ✅ Timetable: periods, weekly grid editor, teacher view, live teacher-clash detection, substitutions with free-teacher lookup, printable PDFs
- ✅ Homework: create/edit with attachments, submissions (text + files), late detection, grading & feedback, parent visibility

## Phase 4 — Communication
- ✅ Announcements: everyone/staff/students/parents/specific classes, categories, pinning, email option
- ✅ In-app notifications (bell + page) and an email outbox architecture
- ✅ Automatic notifications: fee reminders, payments, absences, low attendance, exam schedule & results, homework, leave, meetings, events, admissions
- ✅ Meetings: teacher availability slots, parent booking (only their child's teachers), approval, direct scheduling, notes, history, 24h reminders
- ✅ Events & calendar: event types, class-specific events, announcements, month calendar merging events, exam papers and meetings

## Phase 5 — Reports & finalisation
- ✅ Report registry with 15 reports (students, attendance ×3, fees ×3, admissions, exams ×5, teachers, year comparison), filters by year/class/section/subject/exam/date/student
- ✅ PDF, Excel and CSV export for every report
- ✅ Role dashboards: admin/principal, teacher, accountant, parent, student — all live data
- ✅ 27 API integration tests (auth, isolation, plan gating, suspension, scope, roles, students, admissions, promotion, attendance, fees, exams, reports, dashboards)
- ✅ Production build: API bundle serves the SPA; Dockerfile + compose
- ⚠️ Dockerfile written but not built in this environment (Docker daemon wasn't running)

## Known limitations / next steps
- ⏭️ Plan limits (`maxStudents`, `maxStaff`) are displayed but not enforced
- ⏭️ SMTP driver is a stub (emails are queued and logged)
- ⏭️ Student-specific fee structures are created by student ID; a student picker would be friendlier
- ⏭️ Timetable clash detection covers teachers, not rooms
- ⏭️ Report cards are per exam; a cumulative term/annual report card is a natural next step
- ⏭️ PostgreSQL RLS as defence in depth; S3 storage driver; job queue for multi-instance
- ⏭️ i18n / multi-language UI
