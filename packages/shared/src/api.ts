/** Every API response uses this envelope. */
export type ApiSuccess<T> = { success: true; data: T; meta?: PageMeta };
export type ApiFailure = { success: false; error: { code: string; message: string; details?: unknown } };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
}

/** Shape returned by every report, so exports and future MCP tools can treat them uniformly. */
export interface ReportResult {
  title: string;
  description?: string;
  columns: { key: string; label: string; type?: 'text' | 'number' | 'currency' | 'percent' | 'date' }[];
  rows: Record<string, unknown>[];
  summary?: { label: string; value: string | number }[];
  chart?: { type: 'bar' | 'line' | 'pie'; xKey: string; series: { key: string; label: string }[] };
}

export interface SessionUser {
  id: string;
  email: string | null;
  fullName: string;
  avatarUrl: string | null;
  role: { key: string; name: string; scope: string };
  permissions: string[];
  isPlatformAdmin: boolean;
  school: null | {
    id: string;
    name: string;
    slug: string;
    status: string;
    features: string[];
  };
}
