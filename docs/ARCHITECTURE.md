# Architecture

Edumin is a **modular monolith**: one API process and one PostgreSQL database, organised into self-contained modules. There are no microservices. Everything a module needs (routes, validation, business logic) lives in its folder, and modules share a small core.

```
Browser (React SPA) ──HTTP/JSON──▶ Fastify API ──▶ PostgreSQL
                                      │
                 ┌────────────────────┼─────────────────────┐
              core/                modules/              jobs.ts
   auth · context · http      students, fees, exams,   email outbox,
   permissions · errors       attendance, reports …    meeting reminders
   pdf · export · storage
```

## Request flow

1. `onRequest` resolves the caller from the `edumin_token` cookie or a `Bearer` token: user, role, school, and the school's effective features (plan + overrides).
2. A route's `preValidation: guard('fees.create', { feature: 'fees' })` checks, in order: authenticated → school user → school not suspended/expired → module enabled for the plan → permission. This runs **before** body validation, so unauthorised callers learn nothing about the schema.
3. The handler builds a **`Ctx`** (`userId`, `schoolId`, `roleKey`, `scope`, `permissions`, `features`) and calls a service function.
4. The service enforces data scope and business rules, and queries with `schoolId` from `Ctx`, never from client input.
5. The response uses one envelope: `{ success: true, data, meta? }` or `{ success: false, error: { code, message, details? } }`. A central error handler maps Zod errors to `VALIDATION_ERROR` with field paths, Postgres unique violations to `409 CONFLICT`, and so on.

## Multi-tenancy

- **Shared database, shared schema, `school_id` on every tenant row.** It is the simplest model that scales to thousands of schools and keeps cross-tenant reporting easy for the platform owner.
- `school_id` is always taken from the authenticated context. Services filter with it explicitly; child records (sections, papers, invoices) are first loaded and checked against the caller's school before they are used.
- **Logins are per school**: email is unique per `(school_id, email)`, and sign-in requires the school code (from the subdomain or the login form). Platform admins have `school_id = NULL`.
- Files are stored under `uploads/<schoolId>/…`; downloads re-check the owning school and the entity's access rules.
- Tenant lifecycle: `trial → active`, or `suspended` / `cancelled`. Suspended schools and expired trials are blocked at the guard; data is retained.
- Isolation is covered by tests (`test/core.test.ts › tenant isolation`).
- **Hardening path:** PostgreSQL Row-Level Security can be layered on (set `app.school_id` per transaction) without changing services, because every query already carries `school_id`.

## Roles, permissions and data scope

Two independent axes:

| | Decides | Values |
|---|---|---|
| **Permissions** | *what* you can do | `<module>.<action>` with actions `view · create · edit · delete · approve · export` across 16 modules |
| **Data scope** | *which records* | `school` (everything) · `assigned` (sections the teacher teaches) · `own` (self, or a parent's children) |

Default roles (School Admin, Principal, Teacher, Accountant, Student, Parent) are created per school from `packages/shared/src/permissions.ts`. Schools can edit permissions in **Settings → Roles & permissions** and create custom roles (Librarian, Receptionist…). School Admin is locked to full access.

Scope helpers in `core/context.ts` (`scopedStudentIds`, `scopedSectionIds`, `assertStudentAccess`, `assertCanTeachSection`) are the single source of truth. Every list and detail service uses them.

## Subscription and feature gating

`plans.features` lists enabled modules. `schools.featureOverrides` toggles individual features per school. The effective set is computed per request and checked by `guard(…, { feature })`. The UI hides modules that aren't enabled. Billing is manual (a `subscription_events` ledger) so automated payments can be added later without schema changes.

## Data model (high level)

```
plans ─< schools ─< roles ─< users ─ staff_profiles
            │
            ├─< academic_years ─< sections >─ classes        subjects
            │                        │  └─< section_subjects >─┘ (+ teacher)
            ├─< students ─< enrollments (student × year × section) ← academic history
            │      └─< student_guardians >─ guardians (─ users for parent login)
            ├─< admission_enquiries, admission_applications
            ├─< attendance_records, staff_attendance, leave_requests
            ├─< fee_heads, fee_structures, fee_concessions, fee_invoices ─< payment_allocations >─ payments
            ├─< grading_scales, exams ─< exam_papers ─< marks
            ├─< periods, timetable_entries ─< substitutions
            ├─< assignments ─< submissions
            ├─< announcements, notifications, email_outbox
            ├─< meeting_slots, meetings, events
            └─< files, audit_logs, sequences
```

Design notes:

- **History is never overwritten.** Enrollments are per academic year with an outcome (`promoted`, `retained`, `transferred`…). Exam results are always **computed from marks** (`computeResults`), so past years stay reproducible after grading changes, and corrections flow through automatically.
- **Invoices are generated idempotently** from fee structures: unique `(student, structure, period)`. Payments are allocated oldest-first (or to chosen invoices) under row locks, which supports partial payments.
- **Numbering** (admission, receipt, application numbers) uses a per-school atomic counter with a configurable format, e.g. `ADM{YYYY}{SEQ:4}`.
- **Money** is `numeric(12,2)`; dates are `date`; instants are `timestamptz`.

## Cross-cutting services

| Concern | Where | Notes |
|---|---|---|
| Notifications | `core/notify.ts` | In-app notifications + email outbox. `audience.*` resolves recipients (role, class, a student's parents). |
| Email | `drainEmailOutbox` job | `console` driver in dev; `smtp` is the integration point for a provider. |
| PDFs | `core/pdf.ts` | Branded letterhead (logo, colours, contact), tables, footer. Used for receipts, report cards, timetables and report exports. |
| Exports | `core/export.ts` | Any `ReportResult` → CSV / XLSX / PDF. |
| Storage | `core/storage.ts` | Local disk driver behind a `StorageDriver` interface (swap for S3). |
| Payments | `modules/fees/gateway.ts` | `PaymentGateway` interface, with a mock gateway for demos. |
| Jobs | `jobs.ts` | In-process intervals (email outbox, meeting reminders). Move to a queue for multi-node. |
| Audit | `core/audit.ts` | Who did what, written by services on important changes. |

## Frontend

- One SPA for every role. The sidebar and screens adapt to permissions, data scope and enabled features (`useAuth().can / hasFeature`).
- **White-labelling at runtime:** `applyBranding()` sets `--brand`, `--brand-2` and `--brand-accent` CSS variables. Every brand shade is derived with `color-mix()` in Tailwind's theme, so changing a colour in Settings re-themes the app live, with no rebuild.
- Server state goes through TanStack Query. Mutations use `useAction`, which shows toasts, maps field errors and invalidates caches.
- A shared UI kit (`components/ui.tsx`, `DataTable`, `FormModal`, `charts`) provides consistent buttons, tables, modals, loading/empty/error states and confirmation dialogs.
- Every page is lazy-loaded.
