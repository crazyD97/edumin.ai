/**
 * API client. Every call goes through `api()`, which unwraps the
 * `{ success, data }` envelope and throws `ApiError` with the server's
 * code/message/details on failure. Auth is an httpOnly cookie.
 */
import type { PageMeta } from '@edumin/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
  /** Field errors keyed by dotted path, from a VALIDATION_ERROR. */
  get fieldErrors(): Record<string, string> {
    if (this.code !== 'VALIDATION_ERROR' || !Array.isArray(this.details)) return {};
    return Object.fromEntries(this.details.map((d: { path: string; message: string }) => [d.path, d.message]));
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function qs(q?: Query) {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function request(method: string, path: string, body?: unknown, query?: Query): Promise<Response> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${path}${qs(query)}`, {
    method,
    credentials: 'include',
    headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    let err: any = null;
    try {
      err = (await res.json()).error;
    } catch {
      /* non-JSON error */
    }
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('edumin:unauthorized'));
    throw new ApiError(res.status, err?.code ?? 'HTTP_' + res.status, err?.message ?? res.statusText, err?.details);
  }
  return res;
}

export async function api<T = any>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const res = await request(method, path, body, query);
  return (await res.json()).data as T;
}

/** For list endpoints that return pagination meta (and optional summary). */
export async function apiPage<T = any>(path: string, query?: Query): Promise<{ rows: T[]; meta: PageMeta; summary?: any }> {
  const res = await request('GET', path, undefined, query);
  const j = await res.json();
  return { rows: j.data, meta: j.meta, summary: j.summary };
}

export const get = <T = any>(path: string, query?: Query) => api<T>('GET', path, undefined, query);
export const post = <T = any>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const put = <T = any>(path: string, body?: unknown) => api<T>('PUT', path, body ?? {});
export const patch = <T = any>(path: string, body?: unknown) => api<T>('PATCH', path, body ?? {});
export const del = <T = any>(path: string) => api<T>('DELETE', path);

/** Downloads a binary response (PDF/XLSX/CSV) and saves it with the server's filename. */
export async function download(method: 'GET' | 'POST', path: string, body?: unknown, query?: Query) {
  const res = await request(method, path, body, query);
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'download';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Opens a PDF in a new tab (falls back to download if popups are blocked). */
export async function openPdf(path: string, query?: Query) {
  const win = window.open('', '_blank');
  try {
    const res = await request('GET', path, undefined, query);
    const url = URL.createObjectURL(await res.blob());
    if (win) win.location.href = url;
    else window.location.href = url;
  } catch (e) {
    win?.close();
    throw e;
  }
}

export async function upload(file: File, fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', file);
  return api<{ id: string; url: string; filename: string }>('POST', '/files', fd);
}
