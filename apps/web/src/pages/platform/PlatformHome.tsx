import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Building2, GraduationCap, IndianRupee, Timer, Users } from 'lucide-react';
import { get } from '@/lib/api';
import { ago, money, num } from '@/lib/format';
import { Card, EmptyState, ErrorState, LinkButton, Loading, PageHeader, Stat } from '@/components/ui';
import { BarsChart, ChartEmpty } from '@/components/charts';

export function PlatformHomePage() {
  const q = useQuery({ queryKey: ['platform-stats'], queryFn: () => get<any>('/platform/stats') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data;
  return (
    <>
      <PageHeader title="Platform overview" description="All tenants on Edumin." actions={<LinkButton to="/platform/schools?new=1" variant="primary" icon={<Building2 className="size-4" />}>Onboard school</LinkButton>} />
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Schools" value={d.schools.total} sub={`${d.schools.active ?? 0} active · ${d.schools.trial ?? 0} on trial · ${d.schools.suspended ?? 0} suspended`} icon={<Building2 className="size-5" />} to="/platform/schools" />
        <Stat label="Monthly recurring revenue" value={money(d.mrr, { compact: true })} sub="Active schools × plan price" icon={<IndianRupee className="size-5" />} tone="green" />
        <Stat label="Active students" value={num(d.activeStudents)} icon={<GraduationCap className="size-5" />} tone="violet" />
        <Stat label="User accounts" value={num(d.users)} icon={<Users className="size-5" />} tone="blue" />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="New schools" subtitle="Last 12 months" className="xl:col-span-2">
          {d.growth.length ? <BarsChart data={d.growth} xKey="month" series={[{ key: 'n', label: 'Schools onboarded' }]} /> : <ChartEmpty />}
        </Card>
        <Card title="Schools by plan" padded={false}>
          <ul className="divide-y divide-slate-100">
            {d.byPlan.map((p: any) => (
              <li key={p.plan} className="flex items-center justify-between px-5 py-3 text-sm">
                <span className="font-medium text-slate-800">{p.plan}</span>
                <span className="text-slate-500 tabular-nums">
                  {p.n} · {money(p.mrr, { compact: true })}/mo
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title="Trials ending soon" className="mt-6" padded={false}>
        {d.expiringTrials.length ? (
          <ul className="divide-y divide-slate-100">
            {d.expiringTrials.map((s: any) => (
              <li key={s.id}>
                <Link to={`/platform/schools/${s.id}`} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50">
                  <span className="text-sm font-medium text-slate-800">{s.name}</span>
                  <span className="flex items-center gap-1.5 text-sm text-amber-700">
                    <Timer className="size-4" /> ends {ago(s.trialEndsAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No trials ending in the next 14 days" />
        )}
      </Card>
    </>
  );
}
