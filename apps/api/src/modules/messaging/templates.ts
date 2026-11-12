/**
 * Message templates per event.
 *
 * WhatsApp (Meta) and SMS (DLT, India) only deliver pre-approved templates, so
 * the wording here must match what is registered on those platforms. `vars`
 * fixes the order of the {{1}}, {{2}}… placeholders. See docs/MESSAGING.md.
 */
import type { MessageEvent } from '@edumin/shared';

export interface TemplateDef {
  /** Meta template name (category: utility). */
  whatsapp: string;
  vars: string[];
  subject: string;
  text: string;
}

export const TEMPLATES: Record<MessageEvent, TemplateDef> = {
  fee_reminder: {
    whatsapp: 'edumin_fee_reminder',
    vars: ['school', 'student', 'amount', 'link'],
    subject: 'Fee reminder for {{student}}',
    text: 'Dear Parent, the fee balance of {{amount}} for {{student}} at {{school}} is overdue. You can pay online here: {{link}}',
  },
  fee_receipt: {
    whatsapp: 'edumin_fee_receipt',
    vars: ['school', 'student', 'amount', 'receipt'],
    subject: 'Payment received – receipt {{receipt}}',
    text: 'Dear Parent, {{school}} has received {{amount}} towards the fees of {{student}}. Receipt no. {{receipt}} is attached. Thank you.',
  },
  attendance_absent: {
    whatsapp: 'edumin_absent_alert',
    vars: ['school', 'student', 'date'],
    subject: '{{student}} was absent today',
    text: 'Dear Parent, {{student}} was marked absent at {{school}} on {{date}}. Please contact the school if this is unexpected.',
  },
  attendance_low: {
    whatsapp: 'edumin_low_attendance',
    vars: ['school', 'student', 'percent', 'threshold'],
    subject: 'Low attendance: {{student}}',
    text: 'Dear Parent, the attendance of {{student}} at {{school}} is {{percent}}, below the required {{threshold}}. Please ensure regular attendance.',
  },
  exam_results: {
    whatsapp: 'edumin_exam_results',
    vars: ['school', 'student', 'exam', 'result'],
    subject: '{{exam}} results for {{student}}',
    text: 'Dear Parent, the results of {{exam}} at {{school}} are out. {{student}}: {{result}}. The report card is attached.',
  },
  exam_scheduled: {
    whatsapp: 'edumin_exam_schedule',
    vars: ['school', 'exam', 'date'],
    subject: '{{exam}} schedule published',
    text: 'Dear Parent, {{school}} has published the schedule for {{exam}}, starting {{date}}. Please check the parent app for subject-wise dates.',
  },
  homework: {
    whatsapp: 'edumin_homework',
    vars: ['school', 'student', 'title', 'due'],
    subject: 'New homework for {{student}}',
    text: 'Dear Parent, new homework for {{student}} at {{school}}: {{title}}. Due on {{due}}.',
  },
  meeting: {
    whatsapp: 'edumin_meeting_update',
    vars: ['school', 'detail'],
    subject: 'Parent–teacher meeting update',
    text: '{{school}}: {{detail}}',
  },
  announcement: {
    whatsapp: 'edumin_announcement',
    vars: ['school', 'title', 'message'],
    subject: '{{title}}',
    text: '{{school}} – {{title}}: {{message}}',
  },
  event: {
    whatsapp: 'edumin_event',
    vars: ['school', 'title', 'when'],
    subject: '{{title}}',
    text: '{{school}}: {{title}} on {{when}}.',
  },
  portal_credentials: {
    whatsapp: 'edumin_portal_login',
    vars: ['school', 'name', 'login', 'password', 'link'],
    subject: 'Your {{school}} parent app login',
    text: 'Dear {{name}}, your {{school}} parent app is ready. Login: {{login}} Password: {{password}} Open: {{link}}',
  },
  admission: {
    whatsapp: 'edumin_admission_update',
    vars: ['school', 'student', 'status', 'ref'],
    subject: 'Admission update for {{student}}',
    text: 'Dear Parent, the admission application {{ref}} for {{student}} at {{school}} is now: {{status}}.',
  },
};

/** WhatsApp template parameters can't contain newlines, tabs or 4+ spaces. */
const clean = (v: string) => v.replace(/[\n\r\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 900);

export function renderTemplate(event: MessageEvent, vars: Record<string, string | number | null | undefined>) {
  const def = TEMPLATES[event];
  const values = Object.fromEntries(def.vars.map((k) => [k, clean(String(vars[k] ?? ''))]));
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? '');
  return { subject: fill(def.subject), text: fill(def.text), params: def.vars.map((k) => values[k]), whatsappTemplate: def.whatsapp };
}
