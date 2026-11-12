/**
 * Outbound messaging (email, WhatsApp, SMS) shared by API and web.
 *
 * Schools turn channels on/off and choose which events go to which channel.
 * WhatsApp and SMS consume message credits that schools buy from the platform;
 * email is included free.
 */

export const CHANNELS = ['email', 'whatsapp', 'sms'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };

/** Credits consumed per message. */
export const CREDIT_COST: Record<Channel, number> = { email: 0, whatsapp: 1, sms: 1 };

export interface CreditPack {
  key: string;
  credits: number;
  price: number; // INR, inclusive of GST
  label: string;
}

export const CREDIT_PACKS: CreditPack[] = [
  { key: 'starter_1k', credits: 1000, price: 499, label: 'Starter' },
  { key: 'school_5k', credits: 5000, price: 2249, label: 'School' },
  { key: 'campus_20k', credits: 20000, price: 7999, label: 'Campus' },
];

/** Events that can be delivered to parents/staff outside the app. */
export const MESSAGE_EVENTS = {
  fee_reminder: { label: 'Fee reminders', audience: 'Parents', description: 'Overdue fee balance with a pay link' },
  fee_receipt: { label: 'Payment receipts', audience: 'Parents', description: 'Receipt PDF after every payment' },
  attendance_absent: { label: 'Absence alerts', audience: 'Parents', description: 'Same-day alert when a child is marked absent' },
  attendance_low: { label: 'Low attendance warnings', audience: 'Parents', description: 'When attendance falls below the threshold' },
  exam_results: { label: 'Results & report cards', audience: 'Parents', description: 'Report card PDF when results are published' },
  exam_scheduled: { label: 'Exam schedules', audience: 'Parents', description: 'When an exam timetable is published' },
  homework: { label: 'New homework', audience: 'Parents', description: 'When a teacher sets homework' },
  meeting: { label: 'Meetings', audience: 'Parents & teachers', description: 'Parent–teacher meeting confirmations and reminders' },
  announcement: { label: 'Announcements', audience: 'Everyone addressed', description: 'Notices marked “also send outside the app”' },
  event: { label: 'Events & holidays', audience: 'Everyone addressed', description: 'Event and holiday announcements' },
  portal_credentials: { label: 'Portal login details', audience: 'Parents', description: 'Mobile number and password for the parent app' },
  admission: { label: 'Admission updates', audience: 'Applicants', description: 'Application received and decisions' },
} as const;
export type MessageEvent = keyof typeof MESSAGE_EVENTS;
export const MESSAGE_EVENT_KEYS = Object.keys(MESSAGE_EVENTS) as MessageEvent[];

export interface MessagingSettings {
  channels: Record<Channel, boolean>;
  /** Which channels each event goes out on. In-app notifications are always sent. */
  events: Partial<Record<MessageEvent, Channel[]>>;
  /** Low-balance warning threshold in credits. */
  lowCreditAlert: number;
}

export const DEFAULT_MESSAGING: MessagingSettings = {
  channels: { email: true, whatsapp: false, sms: false },
  events: {
    fee_reminder: ['email', 'whatsapp'],
    fee_receipt: ['email', 'whatsapp'],
    attendance_absent: ['whatsapp', 'sms'],
    attendance_low: ['email', 'whatsapp'],
    exam_results: ['email', 'whatsapp'],
    exam_scheduled: ['email'],
    homework: [],
    meeting: ['email', 'whatsapp'],
    announcement: ['email', 'whatsapp'],
    event: ['email'],
    portal_credentials: ['whatsapp', 'sms'],
    admission: ['email', 'sms'],
  },
  lowCreditAlert: 200,
};

/** Normalises an Indian mobile number to E.164 digits (91XXXXXXXXXX), or null. */
export function normalizeIndianMobile(raw?: string | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return /^91[6-9]\d{9}$/.test(d) ? d : null;
}
