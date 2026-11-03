import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgres://postgres@localhost:5433/edumin'),
  JWT_SECRET: z.string().min(16).default('dev-only-insecure-secret-change-me'),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().default('http://localhost:5173'),
  ROOT_DOMAIN: z.string().default('edumin.localhost'),
  UPLOAD_DIR: z.string().default('./uploads'),
  EMAIL_DRIVER: z.enum(['console', 'smtp', 'none']).default('console'),
  PAYMENT_GATEWAY: z.string().default('mock'),
  /** Built web app to serve (production). Ignored when missing. */
  WEB_DIST: z.string().default('../web/dist'),
});

export const env = schema.parse(process.env);

if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('dev-only')) {
  throw new Error('JWT_SECRET must be set in production');
}
