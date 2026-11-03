import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, get } from './api';
import { useAuth } from './auth';

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Mutation with toast feedback and cache invalidation. */
export function useAction<TVars = void, TRes = any>(
  fn: (vars: TVars) => Promise<TRes>,
  opts: { success?: string | ((r: TRes) => string); invalidate?: unknown[][]; onSuccess?: (r: TRes, vars: TVars) => void; onError?: (e: ApiError) => void } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r, vars) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      for (const key of opts.invalidate ?? []) await qc.invalidateQueries({ queryKey: key });
      opts.onSuccess?.(r, vars);
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        if (opts.onError) opts.onError(e);
        if (!opts.onError || e.code !== 'VALIDATION_ERROR') toast.error(e.message);
      } else toast.error('Something went wrong');
    },
  });
}

// ── Shared lookups (cached across screens) ──
export interface ClassRow {
  id: string;
  name: string;
  level: number;
}
export interface SectionRow {
  id: string;
  name: string;
  classId: string;
  className: string;
  classLevel: number;
  label: string;
  classTeacherId: string | null;
  classTeacherName: string | null;
  studentCount: number;
  capacity: number | null;
  room: string | null;
  academicYearId: string;
}
export interface YearRow {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}

export const useYears = () => useQuery({ queryKey: ['years'], queryFn: () => get<YearRow[]>('/academic-years'), staleTime: 5 * 60_000 });
export const useClasses = () => useQuery({ queryKey: ['classes'], queryFn: () => get<ClassRow[]>('/classes'), staleTime: 5 * 60_000 });
export const useSubjects = () => useQuery({ queryKey: ['subjects'], queryFn: () => get<{ id: string; name: string; code: string | null; type: string }[]>('/subjects'), staleTime: 5 * 60_000 });
export const useSections = (academicYearId?: string) =>
  useQuery({ queryKey: ['sections', academicYearId ?? 'current'], queryFn: () => get<SectionRow[]>('/sections', { academicYearId }), staleTime: 60_000 });
export function useTeachers() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['teachers'], queryFn: () => get<{ id: string; fullName: string }[]>('/staff/teachers'), staleTime: 5 * 60_000, enabled: !!user?.school && user.role.scope !== 'own' });
}

export const toOptions = <T extends { id: string }>(rows: T[] | undefined, label: (r: T) => string) => (rows ?? []).map((r) => ({ value: r.id, label: label(r) }));
