export const SCHOOL_STATUSES = ['trial', 'active', 'suspended', 'cancelled'] as const;
export type SchoolStatus = (typeof SCHOOL_STATUSES)[number];

export const STUDENT_STATUSES = ['active', 'inactive', 'transferred', 'withdrawn', 'graduated'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const GENDERS = ['male', 'female', 'other'] as const;

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'half_day'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const APPLICATION_STATUSES = ['submitted', 'under_review', 'approved', 'rejected', 'enrolled'] as const;
export const ENQUIRY_STATUSES = ['new', 'contacted', 'converted', 'closed'] as const;

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

export const FEE_FREQUENCIES = ['one_time', 'monthly', 'quarterly', 'annual'] as const;
export type FeeFrequency = (typeof FEE_FREQUENCIES)[number];
export const INVOICE_STATUSES = ['unpaid', 'partial', 'paid', 'cancelled'] as const;
export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'cheque', 'card', 'upi', 'online'] as const;
export const CONCESSION_KINDS = ['discount', 'scholarship'] as const;

export const EXAM_STATUSES = ['draft', 'scheduled', 'marks_entry', 'published'] as const;

export const DAYS = [
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
] as const;

export const SUBMISSION_STATUSES = ['pending', 'submitted', 'late', 'graded'] as const;

export const ANNOUNCEMENT_AUDIENCES = ['all', 'staff', 'students', 'parents', 'classes'] as const;
export const ANNOUNCEMENT_CATEGORIES = ['general', 'exam', 'event', 'fee', 'attendance', 'holiday'] as const;

export const MEETING_STATUSES = ['requested', 'approved', 'rejected', 'cancelled', 'completed'] as const;

export const EVENT_TYPES = ['event', 'holiday', 'sports', 'function', 'exam', 'ptm', 'other'] as const;
