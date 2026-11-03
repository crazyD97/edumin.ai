import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { apiPage, post } from '@/lib/api';
import { useAction, useSections, useYears, toOptions } from '@/lib/hooks';
import { Button, Card, EmptyState, Field, Loading, PageHeader, Select } from '@/components/ui';

type Action = 'promote' | 'retain' | 'graduate' | 'leave';

export function PromotionPage() {
  const navigate = useNavigate();
  const years = useYears();
  const current = years.data?.find((y) => y.isCurrent);
  const [fromYear, setFromYear] = useState('');
  const [toYear, setToYear] = useState('');
  const [fromSection, setFromSection] = useState('');
  const [defaultTarget, setDefaultTarget] = useState('');
  const [rows, setRows] = useState<Record<string, { action: Action; toSectionId: string }>>({});

  useEffect(() => {
    if (current && !fromYear) setFromYear(current.id);
  }, [current, fromYear]);
  const fromSections = useSections(fromYear || undefined);
  const toSections = useSections(toYear || undefined);
  const source = fromSections.data?.find((s) => s.id === fromSection);
  const students = useQuery({
    queryKey: ['students', 'promote', fromSection, fromYear],
    queryFn: () => apiPage('/students', { sectionId: fromSection, academicYearId: fromYear, status: 'active', pageSize: 500 }),
    enabled: !!fromSection,
  });

  // Suggest the next class's section with the same name.
  const suggested = useMemo(() => {
    if (!source || !toSections.data) return '';
    const next = toSections.data.find((s) => s.name === source.name && s.classLevel === source.classLevel + 1);
    return next?.id ?? '';
  }, [source, toSections.data]);

  useEffect(() => {
    setDefaultTarget(suggested);
  }, [suggested]);
  useEffect(() => {
    if (!students.data) return;
    setRows(Object.fromEntries(students.data.rows.map((s: any) => [s.id, { action: 'promote' as Action, toSectionId: '' }])));
  }, [students.data]);

  const items = (students.data?.rows ?? []).map((s: any) => ({ studentId: s.id, action: rows[s.id]?.action ?? 'promote', toSectionId: rows[s.id]?.toSectionId || (rows[s.id]?.action === 'retain' ? '' : defaultTarget) || null }));
  const missing = items.some((i) => (i.action === 'promote' || i.action === 'retain') && !i.toSectionId);
  const run = useAction(() => post('/students/promote', { fromSectionId: fromSection, toAcademicYearId: toYear, items }), {
    success: (r: any) => `Done: ${r.promoted} promoted, ${r.retained} retained, ${r.graduated} graduated, ${r.left} left`,
    invalidate: [['students'], ['sections']],
    onSuccess: () => navigate('/students'),
  });

  return (
    <>
      <PageHeader back={{ to: '/students', label: 'Students' }} title="Promote students" description="Move a class into the next academic year. Each student's history is preserved." />
      <Card className="mb-6">
        <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto_1fr_1fr] md:items-end">
          <Field label="From year">
            <Select value={fromYear} onChange={(e) => setFromYear(e.target.value)} options={toOptions(years.data, (y) => y.name)} />
          </Field>
          <Field label="From section">
            <Select value={fromSection} onChange={(e) => setFromSection(e.target.value)} placeholder="Choose section" options={toOptions(fromSections.data, (s) => `${s.label} (${s.studentCount})`)} />
          </Field>
          <ArrowRight className="mx-auto mb-2.5 hidden size-5 text-slate-400 md:block" />
          <Field label="To year">
            <Select value={toYear} onChange={(e) => setToYear(e.target.value)} placeholder="Choose year" options={toOptions(years.data?.filter((y) => y.id !== fromYear), (y) => y.name)} />
          </Field>
          <Field label="Default target section">
            <Select value={defaultTarget} onChange={(e) => setDefaultTarget(e.target.value)} placeholder={toYear ? 'Choose section' : 'Pick a year first'} options={toOptions(toSections.data, (s) => s.label)} disabled={!toYear} />
          </Field>
        </div>
        {toYear && !toSections.data?.length && <p className="mt-3 text-sm text-amber-700">The target year has no sections. Use “Copy structure” under Classes & Subjects → Academic years first.</p>}
      </Card>
      {fromSection && (
        <Card padded={false} title={source?.label} subtitle="Choose an outcome per student; the default target applies unless you pick another section.">
          {students.isLoading ? (
            <Loading />
          ) : !students.data?.rows.length ? (
            <EmptyState title="No active students in this section" />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead className="bg-slate-50/70">
                  <tr>
                    <th className="th">Student</th>
                    <th className="th">Outcome</th>
                    <th className="th">Target section</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {students.data.rows.map((s: any) => {
                    const r = rows[s.id] ?? { action: 'promote', toSectionId: '' };
                    const set = (patch: Partial<typeof r>) => setRows((p) => ({ ...p, [s.id]: { ...r, ...patch } }));
                    return (
                      <tr key={s.id}>
                        <td className="td">
                          <span className="font-medium text-slate-900">
                            {s.firstName} {s.lastName}
                          </span>{' '}
                          <span className="text-xs text-slate-500">#{s.rollNo}</span>
                        </td>
                        <td className="td">
                          <Select
                            className="w-40"
                            value={r.action}
                            onChange={(e) => set({ action: e.target.value as Action })}
                            options={[
                              { value: 'promote', label: 'Promote' },
                              { value: 'retain', label: 'Retain (repeat)' },
                              { value: 'graduate', label: 'Graduate' },
                              { value: 'leave', label: 'Leaving school' },
                            ]}
                          />
                        </td>
                        <td className="td">
                          {r.action === 'promote' || r.action === 'retain' ? (
                            <Select className="w-48" value={r.toSectionId} onChange={(e) => set({ toSectionId: e.target.value })} placeholder={r.action === 'promote' ? 'Default target' : 'Choose section'} options={toOptions(toSections.data, (x) => x.label)} />
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-end gap-3 border-t border-slate-100 px-5 py-3">
            {missing && <span className="text-sm text-amber-700">Choose a target section for promoted/retained students</span>}
            <Button disabled={!toYear || missing || !items.length} loading={run.isPending} onClick={() => run.mutate()}>
              Apply to {items.length} students
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}

