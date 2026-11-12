/**
 * Database schema.
 *
 * Tenancy rule: every table holding school data has a non-null `school_id`
 * column, and every query against it must filter by the caller's school.
 * Services receive the school id from the authenticated request context,
 * never from client input. Platform tables (plans, schools) and the super
 * admin (users.school_id IS NULL) are the only exceptions.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  numeric,
  date,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  smallint,
  time,
} from 'drizzle-orm/pg-core';
import { DEFAULT_MESSAGING, type Branding, type MessagingSettings, type SchoolSettings } from '@edumin/shared';

const id = () => uuid('id').primaryKey().defaultRandom();
const schoolId = () =>
  uuid('school_id')
    .notNull()
    .references(() => schools.id, { onDelete: 'cascade' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: 'number' });
const day = (name: string) => date(name, { mode: 'string' });

// ───────────────────────────── Platform ─────────────────────────────

export const plans = pgTable('plans', {
  id: id(),
  code: varchar('code', { length: 50 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  priceMonthly: money('price_monthly').notNull().default(0),
  priceYearly: money('price_yearly').notNull().default(0),
  maxStudents: integer('max_students'),
  maxStaff: integer('max_staff'),
  features: jsonb('features').$type<string[]>().notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const schools = pgTable('schools', {
  id: id(),
  name: varchar('name', { length: 200 }).notNull(),
  slug: varchar('slug', { length: 63 }).notNull().unique(),
  status: varchar('status', { length: 20 }).notNull().default('trial'),
  planId: uuid('plan_id').references(() => plans.id),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  subscriptionStatus: varchar('subscription_status', { length: 20 }).notNull().default('trialing'),
  subscriptionEndsAt: timestamp('subscription_ends_at', { withTimezone: true }),
  featureOverrides: jsonb('feature_overrides').$type<Record<string, boolean>>().notNull().default({}),
  branding: jsonb('branding').$type<Branding>().notNull(),
  settings: jsonb('settings').$type<SchoolSettings>().notNull(),
  messaging: jsonb('messaging').$type<MessagingSettings>().notNull().default(DEFAULT_MESSAGING),
  messageCredits: integer('message_credits').notNull().default(0),
  notes: text('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Manual subscription ledger; automated billing can write here later. */
export const subscriptionEvents = pgTable('subscription_events', {
  id: id(),
  schoolId: schoolId(),
  type: varchar('type', { length: 40 }).notNull(), // plan_changed, extended, suspended, payment_recorded
  planId: uuid('plan_id').references(() => plans.id),
  amount: money('amount'),
  note: text('note'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

// ───────────────────────────── Identity ─────────────────────────────

export const roles = pgTable(
  'roles',
  {
    id: id(),
    schoolId: schoolId(),
    key: varchar('key', { length: 50 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    scope: varchar('scope', { length: 20 }).notNull().default('school'),
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('roles_school_key').on(t.schoolId, t.key)],
);

export const users = pgTable(
  'users',
  {
    id: id(),
    schoolId: uuid('school_id').references(() => schools.id, { onDelete: 'cascade' }), // null = platform admin
    roleId: uuid('role_id').references(() => roles.id),
    email: varchar('email', { length: 255 }), // optional: parents often sign in with a mobile number
    passwordHash: text('password_hash').notNull(),
    fullName: varchar('full_name', { length: 200 }).notNull(),
    phone: varchar('phone', { length: 30 }),
    avatarUrl: text('avatar_url'),
    isActive: boolean('is_active').notNull().default(true),
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    tokenVersion: integer('token_version').notNull().default(0),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_school_email').on(t.schoolId, t.email),
    uniqueIndex('users_school_phone')
      .on(t.schoolId, t.phone)
      .where(sql`phone is not null`),
    uniqueIndex('users_platform_email')
      .on(t.email)
      .where(sql`school_id is null`),
  ],
);

export const staffProfiles = pgTable(
  'staff_profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    schoolId: schoolId(),
    employeeCode: varchar('employee_code', { length: 50 }),
    designation: varchar('designation', { length: 100 }),
    department: varchar('department', { length: 100 }),
    qualification: varchar('qualification', { length: 200 }),
    joinDate: day('join_date'),
    gender: varchar('gender', { length: 10 }),
    address: text('address'),
  },
  (t) => [index('staff_school').on(t.schoolId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    schoolId: uuid('school_id').references(() => schools.id, { onDelete: 'cascade' }),
    userId: uuid('user_id'),
    action: varchar('action', { length: 60 }).notNull(),
    entity: varchar('entity', { length: 60 }).notNull(),
    entityId: varchar('entity_id', { length: 64 }),
    meta: jsonb('meta'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_school_created').on(t.schoolId, t.createdAt)],
);

export const files = pgTable(
  'files',
  {
    id: id(),
    schoolId: uuid('school_id').references(() => schools.id, { onDelete: 'cascade' }),
    uploadedBy: uuid('uploaded_by'),
    entity: varchar('entity', { length: 40 }), // student, application, assignment, submission, branding
    entityId: uuid('entity_id'),
    category: varchar('category', { length: 60 }),
    filename: varchar('filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 120 }).notNull(),
    size: integer('size').notNull(),
    storageKey: text('storage_key').notNull(),
    isPublic: boolean('is_public').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('files_entity').on(t.schoolId, t.entity, t.entityId)],
);

export const sequences = pgTable(
  'sequences',
  {
    schoolId: schoolId(),
    key: varchar('key', { length: 60 }).notNull(),
    value: integer('value').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.schoolId, t.key] })],
);

// ───────────────────────────── Academic structure ─────────────────────────────

export const academicYears = pgTable(
  'academic_years',
  {
    id: id(),
    schoolId: schoolId(),
    name: varchar('name', { length: 50 }).notNull(),
    startDate: day('start_date').notNull(),
    endDate: day('end_date').notNull(),
    isCurrent: boolean('is_current').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ay_school_name').on(t.schoolId, t.name)],
);

export const classes = pgTable(
  'classes',
  {
    id: id(),
    schoolId: schoolId(),
    name: varchar('name', { length: 50 }).notNull(),
    level: integer('level').notNull().default(0), // ordering + promotion target
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('classes_school_name').on(t.schoolId, t.name)],
);

export const sections = pgTable(
  'sections',
  {
    id: id(),
    schoolId: schoolId(),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 20 }).notNull(),
    classTeacherId: uuid('class_teacher_id').references(() => users.id, { onDelete: 'set null' }),
    capacity: integer('capacity'),
    room: varchar('room', { length: 50 }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sections_unique').on(t.academicYearId, t.classId, t.name)],
);

export const subjects = pgTable(
  'subjects',
  {
    id: id(),
    schoolId: schoolId(),
    name: varchar('name', { length: 100 }).notNull(),
    code: varchar('code', { length: 20 }),
    type: varchar('type', { length: 20 }).notNull().default('theory'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('subjects_school_name').on(t.schoolId, t.name)],
);

/** Which subjects a section studies, and who teaches each. */
export const sectionSubjects = pgTable(
  'section_subjects',
  {
    id: id(),
    schoolId: schoolId(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    teacherId: uuid('teacher_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('section_subject_unique').on(t.sectionId, t.subjectId)],
);

// ───────────────────────────── Students ─────────────────────────────

export const students = pgTable(
  'students',
  {
    id: id(),
    schoolId: schoolId(),
    admissionNo: varchar('admission_no', { length: 50 }).notNull(),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull().default(''),
    dateOfBirth: day('date_of_birth'),
    gender: varchar('gender', { length: 10 }),
    bloodGroup: varchar('blood_group', { length: 5 }),
    photoUrl: text('photo_url'),
    email: varchar('email', { length: 255 }),
    phone: varchar('phone', { length: 30 }),
    address: text('address'),
    nationality: varchar('nationality', { length: 60 }),
    religion: varchar('religion', { length: 60 }),
    previousSchool: varchar('previous_school', { length: 200 }),
    medicalNotes: text('medical_notes'),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    admissionDate: day('admission_date'),
    exitDate: day('exit_date'),
    exitReason: text('exit_reason'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('students_school_admno').on(t.schoolId, t.admissionNo),
    index('students_school_status').on(t.schoolId, t.status),
  ],
);

export const guardians = pgTable(
  'guardians',
  {
    id: id(),
    schoolId: schoolId(),
    name: varchar('name', { length: 200 }).notNull(),
    relation: varchar('relation', { length: 30 }).notNull().default('guardian'),
    phone: varchar('phone', { length: 30 }),
    email: varchar('email', { length: 255 }),
    occupation: varchar('occupation', { length: 100 }),
    address: text('address'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('guardians_school').on(t.schoolId), index('guardians_user').on(t.userId)],
);

export const studentGuardians = pgTable(
  'student_guardians',
  {
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    guardianId: uuid('guardian_id')
      .notNull()
      .references(() => guardians.id, { onDelete: 'cascade' }),
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.studentId, t.guardianId] })],
);

/** One row per student per academic year — this is the academic history. */
export const enrollments = pgTable(
  'enrollments',
  {
    id: id(),
    schoolId: schoolId(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id),
    rollNo: integer('roll_no'),
    status: varchar('status', { length: 20 }).notNull().default('active'), // active, promoted, retained, transferred, withdrawn, completed
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('enrollment_student_year').on(t.studentId, t.academicYearId),
    index('enrollment_section').on(t.sectionId),
  ],
);

// ───────────────────────────── Admissions ─────────────────────────────

export const admissionEnquiries = pgTable(
  'admission_enquiries',
  {
    id: id(),
    schoolId: schoolId(),
    studentName: varchar('student_name', { length: 200 }).notNull(),
    guardianName: varchar('guardian_name', { length: 200 }).notNull(),
    phone: varchar('phone', { length: 30 }).notNull(),
    email: varchar('email', { length: 255 }),
    classId: uuid('class_id').references(() => classes.id, { onDelete: 'set null' }),
    message: text('message'),
    source: varchar('source', { length: 30 }).notNull().default('website'),
    status: varchar('status', { length: 20 }).notNull().default('new'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [index('enq_school_status').on(t.schoolId, t.status)],
);

export const admissionApplications = pgTable(
  'admission_applications',
  {
    id: id(),
    schoolId: schoolId(),
    applicationNo: varchar('application_no', { length: 50 }).notNull(),
    academicYearId: uuid('academic_year_id').references(() => academicYears.id),
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id),
    enquiryId: uuid('enquiry_id').references(() => admissionEnquiries.id, { onDelete: 'set null' }),
    student: jsonb('student')
      .$type<{ firstName: string; lastName?: string | null; dateOfBirth?: string | null; gender?: string | null; previousSchool?: string | null; address?: string | null }>()
      .notNull(),
    guardian: jsonb('guardian').$type<{ name: string; relation?: string | null; phone: string; email?: string | null; occupation?: string | null }>().notNull(),
    status: varchar('status', { length: 20 }).notNull().default('submitted'),
    remarks: text('remarks'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    studentId: uuid('student_id').references(() => students.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('app_school_no').on(t.schoolId, t.applicationNo), index('app_school_status').on(t.schoolId, t.status)],
);

// ───────────────────────────── Attendance ─────────────────────────────

export const attendanceRecords = pgTable(
  'attendance_records',
  {
    id: id(),
    schoolId: schoolId(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    date: day('date').notNull(),
    status: varchar('status', { length: 10 }).notNull(),
    remarks: text('remarks'),
    markedBy: uuid('marked_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('att_student_date').on(t.studentId, t.date),
    index('att_section_date').on(t.sectionId, t.date),
    index('att_school_date').on(t.schoolId, t.date),
  ],
);

export const staffAttendance = pgTable(
  'staff_attendance',
  {
    id: id(),
    schoolId: schoolId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: day('date').notNull(),
    status: varchar('status', { length: 10 }).notNull(),
    remarks: text('remarks'),
    markedBy: uuid('marked_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('staff_att_user_date').on(t.userId, t.date)],
);

export const leaveRequests = pgTable(
  'leave_requests',
  {
    id: id(),
    schoolId: schoolId(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id').references(() => students.id, { onDelete: 'cascade' }), // null = staff leave
    fromDate: day('from_date').notNull(),
    toDate: day('to_date').notNull(),
    type: varchar('type', { length: 30 }).notNull().default('casual'),
    reason: text('reason').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    createdAt: createdAt(),
  },
  (t) => [index('leave_school_status').on(t.schoolId, t.status)],
);

// ───────────────────────────── Fees ─────────────────────────────

export const feeHeads = pgTable(
  'fee_heads',
  {
    id: id(),
    schoolId: schoolId(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('fee_heads_school_name').on(t.schoolId, t.name)],
);

/** A charge rule: applies to a class (or one student) in an academic year. */
export const feeStructures = pgTable('fee_structures', {
  id: id(),
  schoolId: schoolId(),
  academicYearId: uuid('academic_year_id')
    .notNull()
    .references(() => academicYears.id, { onDelete: 'cascade' }),
  feeHeadId: uuid('fee_head_id')
    .notNull()
    .references(() => feeHeads.id),
  classId: uuid('class_id').references(() => classes.id, { onDelete: 'cascade' }),
  studentId: uuid('student_id').references(() => students.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 150 }).notNull(),
  amount: money('amount').notNull(), // per installment
  frequency: varchar('frequency', { length: 20 }).notNull().default('annual'),
  dueDay: smallint('due_day').notNull().default(10),
  lateFeeAmount: money('late_fee_amount').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
});

export const feeConcessions = pgTable('fee_concessions', {
  id: id(),
  schoolId: schoolId(),
  studentId: uuid('student_id')
    .notNull()
    .references(() => students.id, { onDelete: 'cascade' }),
  academicYearId: uuid('academic_year_id')
    .notNull()
    .references(() => academicYears.id, { onDelete: 'cascade' }),
  feeHeadId: uuid('fee_head_id').references(() => feeHeads.id), // null = all heads
  kind: varchar('kind', { length: 20 }).notNull().default('discount'), // discount | scholarship
  valueType: varchar('value_type', { length: 10 }).notNull().default('percent'), // percent | fixed
  value: money('value').notNull(),
  reason: text('reason'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

export const feeInvoices = pgTable(
  'fee_invoices',
  {
    id: id(),
    schoolId: schoolId(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id),
    feeStructureId: uuid('fee_structure_id').references(() => feeStructures.id, { onDelete: 'set null' }),
    feeHeadId: uuid('fee_head_id').references(() => feeHeads.id),
    title: varchar('title', { length: 200 }).notNull(),
    period: varchar('period', { length: 20 }), // e.g. 2026-04, Q1, annual — used for idempotent generation
    dueDate: day('due_date').notNull(),
    amount: money('amount').notNull(),
    discount: money('discount').notNull().default(0),
    scholarship: money('scholarship').notNull().default(0),
    lateFee: money('late_fee').notNull().default(0),
    paid: money('paid').notNull().default(0),
    status: varchar('status', { length: 20 }).notNull().default('unpaid'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('inv_school_status').on(t.schoolId, t.status),
    index('inv_student').on(t.studentId),
    uniqueIndex('inv_structure_period').on(t.studentId, t.feeStructureId, t.period),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    schoolId: schoolId(),
    receiptNo: varchar('receipt_no', { length: 50 }).notNull(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    amount: money('amount').notNull(),
    method: varchar('method', { length: 20 }).notNull(),
    reference: varchar('reference', { length: 100 }),
    status: varchar('status', { length: 20 }).notNull().default('completed'), // pending | completed | failed | refunded
    gateway: varchar('gateway', { length: 30 }),
    gatewayRef: varchar('gateway_ref', { length: 100 }),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
    receivedBy: uuid('received_by'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('payments_school_receipt').on(t.schoolId, t.receiptNo), index('payments_school_paid').on(t.schoolId, t.paidAt)],
);

export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => feeInvoices.id, { onDelete: 'cascade' }),
    amount: money('amount').notNull(),
  },
  (t) => [primaryKey({ columns: [t.paymentId, t.invoiceId] })],
);

// ───────────────────────────── Examinations ─────────────────────────────

export interface GradeBand {
  grade: string;
  min: number; // inclusive percent
  point?: number;
  remark?: string;
}

export const gradingScales = pgTable('grading_scales', {
  id: id(),
  schoolId: schoolId(),
  name: varchar('name', { length: 100 }).notNull(),
  passPercent: money('pass_percent').notNull().default(33),
  bands: jsonb('bands').$type<GradeBand[]>().notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: createdAt(),
});

export const exams = pgTable(
  'exams',
  {
    id: id(),
    schoolId: schoolId(),
    academicYearId: uuid('academic_year_id')
      .notNull()
      .references(() => academicYears.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 150 }).notNull(),
    term: varchar('term', { length: 50 }),
    gradingScaleId: uuid('grading_scale_id').references(() => gradingScales.id),
    startDate: day('start_date'),
    endDate: day('end_date'),
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    description: text('description'),
    createdAt: createdAt(),
  },
  (t) => [index('exams_school_year').on(t.schoolId, t.academicYearId)],
);

/** One paper: exam × class × subject, with its date and marks scheme. */
export const examPapers = pgTable(
  'exam_papers',
  {
    id: id(),
    schoolId: schoolId(),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id, { onDelete: 'cascade' }),
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id),
    date: day('date'),
    startTime: time('start_time'),
    endTime: time('end_time'),
    maxMarks: money('max_marks').notNull().default(100),
    passMarks: money('pass_marks').notNull().default(33),
    room: varchar('room', { length: 50 }),
  },
  (t) => [uniqueIndex('paper_unique').on(t.examId, t.classId, t.subjectId)],
);

export const marks = pgTable(
  'marks',
  {
    id: id(),
    schoolId: schoolId(),
    paperId: uuid('paper_id')
      .notNull()
      .references(() => examPapers.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    marksObtained: money('marks_obtained'),
    isAbsent: boolean('is_absent').notNull().default(false),
    remarks: varchar('remarks', { length: 255 }),
    enteredBy: uuid('entered_by'),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('marks_paper_student').on(t.paperId, t.studentId)],
);

// ───────────────────────────── Timetable ─────────────────────────────

export const periods = pgTable('periods', {
  id: id(),
  schoolId: schoolId(),
  name: varchar('name', { length: 50 }).notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isBreak: boolean('is_break').notNull().default(false),
});

export const timetableEntries = pgTable(
  'timetable_entries',
  {
    id: id(),
    schoolId: schoolId(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    dayOfWeek: smallint('day_of_week').notNull(),
    periodId: uuid('period_id')
      .notNull()
      .references(() => periods.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'set null' }),
    teacherId: uuid('teacher_id').references(() => users.id, { onDelete: 'set null' }),
    room: varchar('room', { length: 50 }),
  },
  (t) => [uniqueIndex('tt_section_slot').on(t.sectionId, t.dayOfWeek, t.periodId), index('tt_teacher').on(t.teacherId, t.dayOfWeek)],
);

export const substitutions = pgTable(
  'substitutions',
  {
    id: id(),
    schoolId: schoolId(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => timetableEntries.id, { onDelete: 'cascade' }),
    date: day('date').notNull(),
    substituteTeacherId: uuid('substitute_teacher_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sub_entry_date').on(t.entryId, t.date)],
);

// ───────────────────────────── Homework ─────────────────────────────

export const assignments = pgTable(
  'assignments',
  {
    id: id(),
    schoolId: schoolId(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'set null' }),
    teacherId: uuid('teacher_id').references(() => users.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    dueDate: day('due_date').notNull(),
    maxMarks: money('max_marks'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('assign_section').on(t.sectionId, t.dueDate)],
);

export const submissions = pgTable(
  'submissions',
  {
    id: id(),
    schoolId: schoolId(),
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'cascade' }),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    content: text('content'),
    status: varchar('status', { length: 20 }).notNull().default('submitted'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    marks: money('marks'),
    feedback: text('feedback'),
    gradedBy: uuid('graded_by'),
    gradedAt: timestamp('graded_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('sub_assign_student').on(t.assignmentId, t.studentId)],
);

// ───────────────────────────── Communication ─────────────────────────────

export const announcements = pgTable(
  'announcements',
  {
    id: id(),
    schoolId: schoolId(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull(),
    category: varchar('category', { length: 20 }).notNull().default('general'),
    audience: varchar('audience', { length: 20 }).notNull().default('all'),
    classIds: jsonb('class_ids').$type<string[]>().notNull().default([]),
    isPinned: boolean('is_pinned').notNull().default(false),
    sendEmail: boolean('send_email').notNull().default(false),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('ann_school_created').on(t.schoolId, t.createdAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    schoolId: uuid('school_id').references(() => schools.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 40 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body'),
    link: varchar('link', { length: 255 }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('notif_user_created').on(t.userId, t.createdAt)],
);

/**
 * Every message sent to parents/staff over email, WhatsApp or SMS. Rows are queued,
 * credits are reserved at queue time, and the delivery job drains the queue.
 */
export const outboundMessages = pgTable(
  'outbound_messages',
  {
    id: id(),
    schoolId: uuid('school_id').references(() => schools.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 12 }).notNull(), // email | whatsapp | sms
    event: varchar('event', { length: 40 }).notNull(),
    recipient: varchar('recipient', { length: 255 }).notNull(), // E.164 digits or email
    recipientName: varchar('recipient_name', { length: 200 }),
    studentId: uuid('student_id'),
    userId: uuid('user_id'),
    subject: varchar('subject', { length: 255 }),
    body: text('body').notNull(),
    params: jsonb('params').$type<string[]>().notNull().default([]),
    attachment: jsonb('attachment').$type<{ kind: string; ref: Record<string, string>; filename: string } | null>(),
    status: varchar('status', { length: 20 }).notNull().default('queued'), // queued | sent | delivered | read | failed | skipped
    credits: integer('credits').notNull().default(0),
    providerRef: varchar('provider_ref', { length: 120 }),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('outbound_school_created').on(t.schoolId, t.createdAt), index('outbound_status').on(t.status), index('outbound_provider_ref').on(t.providerRef)],
);

/** Message-credit ledger. schools.message_credits is the running balance. */
export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: id(),
    schoolId: schoolId(),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    kind: varchar('kind', { length: 20 }).notNull(), // purchase | grant | usage | refund | adjust
    note: text('note'),
    amountPaid: money('amount_paid'),
    reference: varchar('reference', { length: 120 }),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('credit_tx_school').on(t.schoolId, t.createdAt)],
);

/** A school buying a credit pack from the platform. */
export const creditOrders = pgTable('credit_orders', {
  id: id(),
  schoolId: schoolId(),
  packKey: varchar('pack_key', { length: 30 }).notNull(),
  credits: integer('credits').notNull(),
  amount: money('amount').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  gateway: varchar('gateway', { length: 20 }).notNull(),
  gatewayOrderId: varchar('gateway_order_id', { length: 100 }),
  gatewayPaymentId: varchar('gateway_payment_id', { length: 100 }),
  createdBy: uuid('created_by'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/** Per-school third-party connections (e.g. the school's own Razorpay account). Secrets are encrypted. */
export const schoolIntegrations = pgTable(
  'school_integrations',
  {
    schoolId: schoolId(),
    provider: varchar('provider', { length: 30 }).notNull(),
    enabled: boolean('enabled').notNull().default(false),
    config: jsonb('config').$type<Record<string, string>>().notNull().default({}),
    secrets: text('secrets'), // AES-GCM encrypted JSON
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.schoolId, t.provider] })],
);

/** Web Push subscriptions for the installed app. */
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: varchar('user_agent', { length: 255 }),
  createdAt: createdAt(),
});

// ───────────────────────────── Certificates ─────────────────────────────

export const certificates = pgTable(
  'certificates',
  {
    id: id(),
    schoolId: schoolId(),
    studentId: uuid('student_id')
      .notNull()
      .references(() => students.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 20 }).notNull(), // transfer | bonafide | character | study
    serialNo: varchar('serial_no', { length: 50 }).notNull(),
    data: jsonb('data').$type<Record<string, string | null>>().notNull(),
    issuedBy: uuid('issued_by'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
  },
  (t) => [uniqueIndex('cert_school_serial').on(t.schoolId, t.serialNo), index('cert_student').on(t.studentId)],
);

// ───────────────────────────── Meetings ─────────────────────────────

export const meetingSlots = pgTable(
  'meeting_slots',
  {
    id: id(),
    schoolId: schoolId(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    location: varchar('location', { length: 100 }),
    isBooked: boolean('is_booked').notNull().default(false),
  },
  (t) => [index('slots_teacher').on(t.teacherId, t.startsAt)],
);

export const meetings = pgTable(
  'meetings',
  {
    id: id(),
    schoolId: schoolId(),
    teacherId: uuid('teacher_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id').references(() => users.id, { onDelete: 'set null' }),
    studentId: uuid('student_id').references(() => students.id, { onDelete: 'cascade' }),
    slotId: uuid('slot_id').references(() => meetingSlots.id, { onDelete: 'set null' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    location: varchar('location', { length: 100 }),
    agenda: text('agenda'),
    status: varchar('status', { length: 20 }).notNull().default('requested'),
    notes: text('notes'),
    requestedBy: uuid('requested_by'),
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('meetings_school_start').on(t.schoolId, t.startsAt)],
);

// ───────────────────────────── Events ─────────────────────────────

export const events = pgTable(
  'events',
  {
    id: id(),
    schoolId: schoolId(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    type: varchar('type', { length: 20 }).notNull().default('event'),
    startDate: day('start_date').notNull(),
    endDate: day('end_date').notNull(),
    startTime: time('start_time'),
    endTime: time('end_time'),
    location: varchar('location', { length: 150 }),
    classIds: jsonb('class_ids').$type<string[]>().notNull().default([]), // empty = whole school
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('events_school_date').on(t.schoolId, t.startDate)],
);
