/**
 * File storage. The local-disk driver is used for development and single-node
 * deployments; an S3-compatible driver can implement the same interface.
 */
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from './env';

export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

const root = path.resolve(env.UPLOAD_DIR);

export const localStorage: StorageDriver = {
  async put(key, data) {
    const full = safePath(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  },
  get: (key) => readFile(safePath(key)),
  async remove(key) {
    await unlink(safePath(key)).catch(() => {});
  },
};

function safePath(key: string) {
  const full = path.resolve(root, key);
  if (!full.startsWith(root)) throw new Error('Invalid storage key');
  return full;
}

/** Storage keys are namespaced by school so tenants never share a directory. */
export function makeKey(schoolId: string | null, filename: string) {
  const ext = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `${schoolId ?? 'platform'}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}${ext}`;
}

export const storage: StorageDriver = localStorage;

export const ALLOWED_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
