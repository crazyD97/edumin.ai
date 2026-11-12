/** Small crypto helpers: secret encryption at rest and signed links. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env';

const key = () => createHash('sha256').update(env.SECRETS_KEY ?? env.JWT_SECRET).digest();

/** AES-256-GCM; output is base64(iv | tag | ciphertext). */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function decryptJson<T = Record<string, string>>(payload: string | null | undefined): T | null {
  if (!payload) return null;
  try {
    const buf = Buffer.from(payload, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')) as T;
  } catch {
    return null;
  }
}

export const hmacHex = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Signs `subject` with an expiry so a URL can be fetched without a session (e.g. by WhatsApp). */
export function signLink(subject: string, ttlSeconds = 7 * 86400) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { exp, sig: hmacHex(env.JWT_SECRET, `${subject}.${exp}`) };
}

export function verifyLink(subject: string, exp: number, sig: string) {
  return exp > Date.now() / 1000 && safeEqual(sig, hmacHex(env.JWT_SECRET, `${subject}.${exp}`));
}

/** Readable random password for portal accounts (no ambiguous characters). */
export function friendlyPassword(len = 8) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
