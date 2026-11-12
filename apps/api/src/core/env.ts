import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgres://postgres@localhost:5433/edumin'),
  JWT_SECRET: z.string().min(16).default('dev-only-insecure-secret-change-me'),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().default('http://localhost:5173'),
  ROOT_DOMAIN: z.string().default('edumin.localhost'),
  UPLOAD_DIR: z.string().default('./uploads'),
  EMAIL_DRIVER: z.enum(['console', 'resend', 'none']).default('console'),
  /** mock = simulated checkout for demos. Never enabled in production unless set explicitly. */
  PAYMENT_GATEWAY: z.enum(['mock', 'none']).default(process.env.NODE_ENV === 'production' ? 'none' : 'mock'),
  /** Public base URL of the API, used for links WhatsApp must fetch (attachments). Defaults to APP_URL. */
  PUBLIC_URL: z.string().optional(),
  /** Encrypts per-school secrets (e.g. Razorpay keys). Falls back to JWT_SECRET in development. */
  SECRETS_KEY: z.string().optional(),

  // Email: console (log only) | resend
  EMAIL_FROM: z.string().default('Edumin <no-reply@edumin.app>'),
  RESEND_API_KEY: z.string().optional(),
  // WhatsApp Cloud API (platform-owned number). Unset = simulated delivery.
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v22.0'),
  WHATSAPP_TEMPLATE_LANG: z.string().default('en'),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  // SMS via MSG91 (DLT templates). Unset = simulated delivery.
  MSG91_AUTH_KEY: z.string().optional(),
  /** JSON map of event key → MSG91 flow/template id, e.g. {"fee_reminder":"64ab..."} */
  MSG91_TEMPLATES: z.string().default('{}'),
  // Platform Razorpay account (selling message credits). Unset = mock checkout.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Web Push (installed app notifications). Generate with: npx web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:support@edumin.app'),

  /** Built web app to serve (production). Ignored when missing. */
  WEB_DIST: z.string().default('../web/dist'),
});

export const env = schema.parse(process.env);
export const publicUrl = () => (env.PUBLIC_URL ?? env.APP_URL).replace(/\/$/, '');

if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('dev-only')) {
  throw new Error('JWT_SECRET must be set in production');
}
