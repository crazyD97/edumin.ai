import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionUser } from '@edumin/shared';
import { ApiError, get, post } from './api';
import { applyBranding } from './branding';
import { setCurrency } from './format';

export interface SchoolProfile {
  id: string;
  name: string;
  slug: string;
  status: string;
  trialEndsAt: string | null;
  branding: Record<string, any> & { primaryColor: string; logoUrl?: string | null };
  settings: { currency: string; lowAttendanceThreshold: number; workingDays: number[]; [k: string]: any };
}

interface AuthValue {
  user: SessionUser | null;
  school: SchoolProfile | null;
  loading: boolean;
  can: (perm: string) => boolean;
  canAny: (...perms: string[]) => boolean;
  hasFeature: (feature: string) => boolean;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

/** Set on an explicit sign-out so the login redirect doesn't carry the old page as ?next. */
let signedOut = false;
export const wasSignedOut = () => signedOut;

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => get<SessionUser>('/auth/me').catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const user = me.data ?? null;
  if (user) signedOut = false; // a new session supersedes the sign-out
  const school = useQuery({ queryKey: ['school'], queryFn: () => get<SchoolProfile>('/school'), enabled: !!user?.school, staleTime: 10 * 60_000 });

  useEffect(() => {
    if (school.data) {
      applyBranding(school.data);
      setCurrency(school.data.settings?.currency);
    } else if (user && !user.school) applyBranding({ name: 'Platform' });
  }, [school.data, user]);

  useEffect(() => {
    const onUnauthorized = () => qc.setQueryData(['me'], null);
    window.addEventListener('edumin:unauthorized', onUnauthorized);
    return () => window.removeEventListener('edumin:unauthorized', onUnauthorized);
  }, [qc]);

  const perms = new Set(user?.permissions ?? []);
  const features = new Set(user?.school?.features ?? []);
  const value: AuthValue = {
    user,
    school: school.data ?? null,
    loading: me.isLoading || (!!user?.school && school.isLoading),
    can: (p) => perms.has(p),
    canAny: (...ps) => ps.some((p) => perms.has(p)),
    hasFeature: (f) => features.has(f),
    logout: async () => {
      await post('/auth/logout').catch(() => {});
      signedOut = true;
      // Update the live session entry (clear() would orphan its observer and keep the old user),
      // then drop everything else cached for the previous account.
      qc.setQueryData(['me'], null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      applyBranding(null);
    },
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['school'] });
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
