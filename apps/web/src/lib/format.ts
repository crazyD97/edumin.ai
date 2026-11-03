import { format, formatDistanceToNow, parseISO } from 'date-fns';

let currency = 'INR';
export const setCurrency = (c: string) => (currency = c || 'INR');

export const money = (n: number | null | undefined, opts: { compact?: boolean } = {}) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: opts.compact ? 1 : 2,
    minimumFractionDigits: opts.compact ? 0 : 2,
    notation: opts.compact ? 'compact' : 'standard',
  }).format(n ?? 0);

export const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : new Intl.NumberFormat('en-IN').format(n));
export const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '—' : `${Number(n).toFixed(digits)}%`);

const toDate = (d: string | Date) => (typeof d === 'string' ? parseISO(d) : d);
export const fmtDate = (d?: string | Date | null) => (d ? format(toDate(d), 'd MMM yyyy') : '—');
export const fmtShort = (d?: string | Date | null) => (d ? format(toDate(d), 'd MMM') : '—');
export const fmtDateTime = (d?: string | Date | null) => (d ? format(toDate(d), 'd MMM yyyy, h:mm a') : '—');
export const fmtTime = (t?: string | null) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return format(new Date(2000, 0, 1, h, m), 'h:mm a');
};
export const ago = (d?: string | Date | null) => (d ? formatDistanceToNow(toDate(d), { addSuffix: true }) : '—');
export const today = () => format(new Date(), 'yyyy-MM-dd');
export const isoDate = (d: Date) => format(d, 'yyyy-MM-dd');
export const titleCase = (s?: string | null) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');
export const fullName = (s: { firstName?: string; lastName?: string | null }) => `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim();
export const initials = (name?: string | null) =>
  (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
