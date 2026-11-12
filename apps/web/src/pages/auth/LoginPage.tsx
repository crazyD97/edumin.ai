import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams, Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Building2, Lock, Mail, ShieldCheck } from 'lucide-react';
import { ApiError, get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { currentSlug, rememberSlug, subdomainSlug } from '@/lib/tenant';
import { applyBranding } from '@/lib/branding';
import { Button, Field, Input } from '@/components/ui';

interface PublicSchool {
  name: string;
  slug: string;
  branding: { logoUrl?: string | null; primaryColor: string; secondaryColor: string; loginTitle?: string | null; loginSubtitle?: string | null; loginImageUrl?: string | null; address?: string | null; phone?: string | null; email?: string | null };
}

const DEMO = [
  ['School admin', 'admin@greenwood.edu'],
  ['Principal', 'principal@greenwood.edu'],
  ['Teacher', 'priya.nair@greenwood.edu'],
  ['Accountant', 'accounts@greenwood.edu'],
  ['Parent', 'parent@greenwood.edu'],
  ['Student', 'student@greenwood.edu'],
];

export function LoginPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fixedSlug = subdomainSlug();
  const [platform, setPlatform] = useState(params.get('platform') === '1');
  const [slug, setSlug] = useState(currentSlug() ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const school = useQuery({
    queryKey: ['public-school', slug],
    queryFn: () => get<PublicSchool>(`/public/schools/${slug}`),
    enabled: !platform && slug.length >= 3,
    retry: false,
  });
  useEffect(() => applyBranding(!platform && school.data ? school.data : null), [school.data, platform]);

  if (user) return <Navigate to={params.get('next') || '/'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await post('/auth/login', { email, password, schoolSlug: platform ? null : slug.trim().toLowerCase() });
      if (!platform) rememberSlug(slug.trim().toLowerCase());
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate(params.get('next') || '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  };

  const b = !platform ? school.data?.branding : undefined;
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden lg:block" style={{ background: `linear-gradient(135deg, var(--brand), var(--brand-2))` }}>
        {b?.loginImageUrl && <img src={b.loginImageUrl} alt="" className="absolute inset-0 size-full object-cover opacity-25 mix-blend-overlay" />}
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <div className="flex items-center gap-3">
            {b?.logoUrl ? <img src={b.logoUrl} alt="" className="size-11 rounded-xl bg-white/90 object-contain p-1" /> : <div className="grid size-11 place-items-center rounded-xl bg-white/15 text-lg font-bold">{(school.data?.name ?? 'E')[0]}</div>}
            <span className="text-lg font-semibold">{platform ? 'Edumin Platform' : (school.data?.name ?? 'Edumin')}</span>
          </div>
          <div className="max-w-md">
            <h1 className="text-4xl leading-tight font-semibold tracking-tight">{platform ? 'Run every school from one place.' : (b?.loginTitle ?? school.data?.name ?? 'Your school, beautifully organised.')}</h1>
            <p className="mt-4 text-lg text-white/80">{platform ? 'Onboard tenants, manage plans and watch the platform grow.' : (b?.loginSubtitle ?? 'Attendance, fees, exams and communication — in one secure portal.')}</p>
          </div>
          <p className="text-sm text-white/60">{[b?.address, b?.phone].filter(Boolean).join(' · ') || '© Edumin'}</p>
        </div>
      </div>

      <div className="flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            {b?.logoUrl ? <img src={b.logoUrl} alt="" className="mb-3 size-12 object-contain" /> : <div className="mb-3 grid size-12 place-items-center rounded-xl bg-brand text-lg font-bold text-white">{(school.data?.name ?? 'E')[0]}</div>}
            <p className="text-lg font-semibold">{platform ? 'Edumin Platform' : (school.data?.name ?? 'Edumin')}</p>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
          <p className="mt-1 text-sm text-slate-500">{platform ? 'Platform administrator access' : 'Use the account your school gave you.'}</p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            {!platform && !fixedSlug && (
              <Field label="School code" hint={school.isError && slug.length >= 3 ? <span className="text-red-600">No school found with this code</span> : 'e.g. greenwood'}>
                <div className="relative">
                  <Building2 className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
                  <Input className="pl-9" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="your-school" autoCapitalize="none" required />
                </div>
              </Field>
            )}
            <Field label="Email or mobile number">
              <div className="relative">
                <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
                <Input className="pl-9" type="text" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="you@school.edu or 98765 43210" required />
              </div>
            </Field>
            <Field label="Password">
              <div className="relative">
                <Lock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
                <Input className="pl-9" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </div>
            </Field>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <Button type="submit" loading={busy} className="w-full" icon={!busy && <ArrowRight className="size-4" />}>
              Sign in
            </Button>
          </form>

          <div className="mt-6 flex items-center justify-between text-sm">
            <button type="button" onClick={() => setPlatform((p) => !p)} className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-800">
              <ShieldCheck className="size-4" />
              {platform ? 'School sign in' : 'Platform admin'}
            </button>
            {!platform && slug && (
              <Link to={`/apply/${slug}`} className="font-medium text-brand-700 hover:underline">
                Apply for admission
              </Link>
            )}
          </div>

          {import.meta.env.DEV && (
            <div className="mt-8 rounded-xl border border-dashed border-slate-300 p-4 text-xs text-slate-500">
              <p className="mb-2 font-semibold text-slate-700">Demo accounts (password Password@123)</p>
              <div className="grid grid-cols-2 gap-1">
                {DEMO.map(([role, mail]) => (
                  <button
                    key={mail}
                    type="button"
                    className="rounded-md px-2 py-1 text-left hover:bg-slate-100"
                    onClick={() => {
                      setPlatform(false);
                      setSlug('greenwood');
                      setEmail(mail);
                      setPassword('Password@123');
                    }}
                  >
                    {role}
                  </button>
                ))}
                <button
                  type="button"
                  className="col-span-2 rounded-md px-2 py-1 text-left hover:bg-slate-100"
                  onClick={() => {
                    setPlatform(true);
                    setEmail('admin@edumin.app');
                    setPassword('Admin@123');
                  }}
                >
                  Platform super admin
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
