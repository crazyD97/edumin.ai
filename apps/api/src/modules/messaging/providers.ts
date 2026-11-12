/**
 * Delivery providers. Each channel uses a real provider when its credentials
 * are configured, and a simulator otherwise (dev/demo), so every flow works
 * end-to-end before Meta/DLT approval comes through.
 */
import type { Channel, MessageEvent } from '@edumin/shared';
import { env } from '../../core/env';

export interface SendInput {
  event: MessageEvent;
  to: string; // email address or E.164 digits
  subject: string;
  text: string;
  params: string[];
  whatsappTemplate: string;
  attachment?: { filename: string; url: string; buffer: Buffer } | null;
}

export interface SendResult {
  ref: string;
  /** Simulated sends are marked delivered immediately. */
  simulated: boolean;
}

export interface Provider {
  name: string;
  live: boolean;
  send(input: SendInput): Promise<SendResult>;
}

const sim = (channel: string): SendResult => ({ ref: `sim_${channel}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, simulated: true });

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const email: Provider = {
  get name() {
    return env.EMAIL_DRIVER === 'resend' ? 'Resend' : 'Console (simulated)';
  },
  get live() {
    return env.EMAIL_DRIVER === 'resend' && !!env.RESEND_API_KEY;
  },
  async send(m) {
    if (!this.live) {
      if (env.EMAIL_DRIVER === 'console' && env.NODE_ENV === 'development') console.log(`[email] → ${m.to} · ${m.subject}`);
      return sim('email');
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [m.to],
        subject: m.subject,
        text: m.text,
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${escapeHtml(m.text).replace(/\n/g, '<br>')}</div>`,
        attachments: m.attachment ? [{ filename: m.attachment.filename, content: m.attachment.buffer.toString('base64') }] : undefined,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`Resend ${res.status}: ${body?.message ?? res.statusText}`);
    return { ref: String(body.id), simulated: false };
  },
};

const whatsapp: Provider = {
  get name() {
    return this.live ? 'WhatsApp Cloud API' : 'WhatsApp (simulated)';
  },
  get live() {
    return !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
  },
  async send(m) {
    if (!this.live) return sim('whatsapp');
    const components: any[] = [];
    if (m.attachment) components.push({ type: 'header', parameters: [{ type: 'document', document: { link: m.attachment.url, filename: m.attachment.filename } }] });
    components.push({ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text: text || '-' })) });
    const res = await fetch(`https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: m.to,
        type: 'template',
        template: { name: m.whatsappTemplate, language: { code: env.WHATSAPP_TEMPLATE_LANG }, components },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${body?.error?.message ?? res.statusText}`);
    return { ref: String(body.messages?.[0]?.id ?? ''), simulated: false };
  },
};

const msg91Templates = (): Record<string, string> => {
  try {
    return JSON.parse(env.MSG91_TEMPLATES);
  } catch {
    return {};
  }
};

const sms: Provider = {
  get name() {
    return this.live ? 'MSG91' : 'SMS (simulated)';
  },
  get live() {
    return !!env.MSG91_AUTH_KEY;
  },
  async send(m) {
    if (!this.live) return sim('sms');
    const templateId = msg91Templates()[m.event];
    if (!templateId) throw new Error(`No DLT template configured for "${m.event}" (MSG91_TEMPLATES)`);
    const recipient: Record<string, string> = { mobiles: m.to };
    m.params.forEach((p, i) => (recipient[`var${i + 1}`] = p.slice(0, 30))); // DLT variables are limited to 30 chars
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: env.MSG91_AUTH_KEY!, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ template_id: templateId, short_url: '0', recipients: [recipient] }),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || body?.type === 'error') throw new Error(`MSG91: ${body?.message ?? res.statusText}`);
    return { ref: String(body?.message ?? body?.request_id ?? ''), simulated: false };
  },
};

export const providers: Record<Channel, Provider> = { email, whatsapp, sms };

export function providerStatus() {
  return (Object.keys(providers) as Channel[]).map((c) => ({ channel: c, provider: providers[c].name, live: providers[c].live }));
}
