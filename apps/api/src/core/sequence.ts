import { sql } from 'drizzle-orm';
import type { Executor } from './db';
import { sequences } from '../db/schema';

/**
 * Atomically increments a per-school counter and renders it with a format.
 * Tokens: {YYYY} {YY} {MM} {SEQ:n} (zero-padded to n digits).
 */
export async function nextNumber(db: Executor, schoolId: string, key: string, format: string, now = new Date()) {
  const [row] = await db
    .insert(sequences)
    .values({ schoolId, key, value: 1 })
    .onConflictDoUpdate({ target: [sequences.schoolId, sequences.key], set: { value: sql`${sequences.value} + 1` } })
    .returning({ value: sequences.value });
  return formatNumber(format, row.value, now);
}

export function formatNumber(format: string, seq: number, now = new Date()) {
  const yyyy = String(now.getFullYear());
  let out = format
    .replaceAll('{YYYY}', yyyy)
    .replaceAll('{YY}', yyyy.slice(2))
    .replaceAll('{MM}', String(now.getMonth() + 1).padStart(2, '0'));
  out = out.replace(/\{SEQ(?::(\d+))?\}/g, (_, n) => String(seq).padStart(Number(n ?? 1), '0'));
  if (!/\{SEQ/.test(format)) out += String(seq);
  return out;
}
