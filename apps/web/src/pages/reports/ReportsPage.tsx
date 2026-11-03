import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Download, FileSpreadsheet, FileText, Play } from 'lucide-react';
import type { ReportResult } from '@edumin/shared';
import { download, get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAction, useClasses, useSections, useYears, toOptions } from '@/lib/hooks';
import { fmtDate, money, num, pct, titleCase } from '@/lib/format';
import { Button, Card, Checkbox, EmptyState, Field, Input, Loading, PageHeader, Select, clsx } from '@/components/ui';
import { DataTable } from '@/components/DataTable';
import { BarsChart, TrendChart } from '@/components/charts';

interface ReportDef {
  key: string;
  name: string;
  description: string;
  category: string;
  params: { properties?: Record<string, any>; required?: string[] };
}

export function ReportsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const catalogue = useQuery({ queryKey: ['reports'], queryFn: () => get<ReportDef[]>('/reports') });
  const key = params.get('r') ?? catalogue.data?.[0]?.key;
  const def = catalogue.data?.find((r) => r.key === key);
  const groups = useMemo(() => {
    const g = new Map<string, ReportDef[]>();
    catalogue.data?.forEach((r) => g.set(r.category, [...(g.get(r.category) ?? []), r]));
    return [...g.entries()];
  }, [catalogue.data]);
  if (catalogue.isLoading) return <Loading />;
  return (
    <>
      <PageHeader title="Reports & analytics" description="Every report respects your role's permissions and can be exported to PDF, Excel or CSV." />
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <Card padded={false} className="h-fit">
          <nav className="p-2">
            {groups.map(([cat, list]) => (
              <div key={cat} className="mb-2">
                <p className="px-2.5 py-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{cat}</p>
                {list.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => setParams({ r: r.key })}
                    className={clsx('block w-full rounded-lg px-2.5 py-2 text-left text-sm', r.key === key ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100')}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </Card>
        {def ? <Runner key={def.key} def={def} canExport={can('reports.export')} /> : <Card><EmptyState title="No reports available" /></Card>}
      </div>
    </>
  );
}

function Runner({ def, canExport }: { def: ReportDef; canExport: boolean }) {
  const props = def.params.properties ?? {};
  const required = new Set(def.params.required ?? []);
  const [values, setValues] = useState<Record<string, any>>(() => Object.fromEntries(Object.entries(props).map(([k, s]) => [k, s.default ?? (s.type === 'array' ? [] : '')])));
  const [result, setResult] = useState<ReportResult | null>(null);
  const run = useAction(() => post<ReportResult>(`/reports/${def.key}/run`, { params: clean(values) }), { onSuccess: setResult });
  const missing = [...required].some((k) => !values[k] || (Array.isArray(values[k]) && !values[k].length));
  useEffect(() => {
    if (!missing) run.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [exporting, setExporting] = useState<string | null>(null);
  const exp = async (format: 'pdf' | 'xlsx' | 'csv') => {
    setExporting(format);
    try {
      await download('POST', `/reports/${def.key}/export`, { format, params: clean(values) });
    } finally {
      setExporting(null);
    }
  };
  return (
    <div className="min-w-0 space-y-6">
      <Card title={def.name} subtitle={def.description}>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Object.entries(props).map(([k, schema]) => (
            <ParamField key={k} name={k} schema={schema} value={values[k]} onChange={(v) => setValues((p) => ({ ...p, [k]: v, ...(k === 'classId' ? { sectionId: '' } : {}) }))} classId={values.classId} required={required.has(k)} />
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button icon={<Play className="size-4" />} disabled={missing} loading={run.isPending} onClick={() => run.mutate()}>
            Run report
          </Button>
          {canExport && result && (
            <div className="ml-auto flex gap-2">
              <Button variant="secondary" size="sm" icon={<FileText className="size-4" />} loading={exporting === 'pdf'} onClick={() => exp('pdf')}>
                PDF
              </Button>
              <Button variant="secondary" size="sm" icon={<FileSpreadsheet className="size-4" />} loading={exporting === 'xlsx'} onClick={() => exp('xlsx')}>
                Excel
              </Button>
              <Button variant="secondary" size="sm" icon={<Download className="size-4" />} loading={exporting === 'csv'} onClick={() => exp('csv')}>
                CSV
              </Button>
            </div>
          )}
        </div>
      </Card>
      {run.isPending && !result ? (
        <Loading />
      ) : result ? (
        <>
          {!!result.summary?.length && (
            <div className="flex flex-wrap gap-3">
              {result.summary.map((s) => (
                <div key={s.label} className="card px-4 py-3">
                  <p className="text-xs text-slate-500">{titleCase(s.label)}</p>
                  <p className="text-lg font-semibold tabular-nums">{typeof s.value === 'string' && /^\d+\.\d{2}$/.test(s.value) ? money(Number(s.value)) : s.value}</p>
                </div>
              ))}
            </div>
          )}
          {result.chart && result.rows.length > 1 && (
            <Card title="Chart">
              {result.chart.type === 'line' ? (
                <TrendChart data={result.rows} xKey={result.chart.xKey} series={result.chart.series} height={260} />
              ) : (
                <BarsChart data={result.rows} xKey={result.chart.xKey} series={result.chart.series.slice(0, 3)} height={260} />
              )}
            </Card>
          )}
          <Card padded={false} title={result.title} subtitle={`${result.rows.length} rows${result.description ? ` · ${result.description}` : ''}`}>
            <DataTable
              rows={result.rows.slice(0, 500)}
              rowKey={(_, i) => String(i)}
              dense
              columns={result.columns.map((c) => ({
                key: c.key,
                header: c.label,
                align: c.type && !['text', 'date'].includes(c.type) ? ('right' as const) : undefined,
                render: (r: any) => fmt(r[c.key], c.type),
              }))}
              empty={<EmptyState icon={<BarChart3 className="size-5" />} title="No data for these filters" />}
            />
            {result.rows.length > 500 && <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">Showing the first 500 rows. Export to see all {result.rows.length}.</p>}
          </Card>
        </>
      ) : null}
    </div>
  );
}

const clean = (v: Record<string, any>) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x !== null && !(Array.isArray(x) && !x.length)));

function fmt(v: any, type?: string) {
  if (v === null || v === undefined || v === '') return '—';
  if (type === 'currency') return money(Number(v));
  if (type === 'percent') return pct(Number(v));
  if (type === 'number') return num(Number(v));
  if (type === 'date') return fmtDate(String(v));
  return String(v);
}

const LABELS: Record<string, string> = {
  academicYearId: 'Academic year',
  academicYearIds: 'Academic years',
  classId: 'Class',
  sectionId: 'Section',
  examId: 'Examination',
  studentId: 'Student',
  from: 'From',
  to: 'To',
  below: 'Attendance below (%)',
  overdueOnly: 'Overdue only',
  minBalance: 'Minimum balance',
  examName: 'Exam name contains',
};

function ParamField({ name, schema, value, onChange, classId, required }: { name: string; schema: any; value: any; onChange: (v: any) => void; classId?: string; required: boolean }) {
  const years = useYears();
  const classes = useClasses();
  const sections = useSections();
  const exams = useQuery({ queryKey: ['exams', 'all-years', years.data?.length], queryFn: async () => (await Promise.all((years.data ?? []).map((y) => get<any[]>('/exams', { academicYearId: y.id }).then((l) => l.map((e) => ({ ...e, yearName: y.name })))))).flat(), enabled: name === 'examId' && !!years.data });
  const [studentSearch, setStudentSearch] = useState('');
  const students = useQuery({ queryKey: ['students', 'report', studentSearch], queryFn: () => get<any[]>('/students', { search: studentSearch, pageSize: 8, status: '' }), enabled: name === 'studentId' && studentSearch.length >= 2 });
  const label = LABELS[name] ?? titleCase(name);
  const enumValues: string[] | undefined = schema.enum ?? schema.anyOf?.find((x: any) => x.enum)?.enum;

  if (name === 'academicYearId') return <Field label={label}><Select value={value} onChange={(e) => onChange(e.target.value)} placeholder="Current year" options={toOptions(years.data, (y) => y.name)} /></Field>;
  if (name === 'classId') return <Field label={label} required={required}><Select value={value} onChange={(e) => onChange(e.target.value)} placeholder={required ? 'Choose class' : 'All classes'} options={toOptions(classes.data, (c) => c.name)} /></Field>;
  if (name === 'sectionId') return <Field label={label}><Select value={value} onChange={(e) => onChange(e.target.value)} placeholder="All sections" options={toOptions(sections.data?.filter((s) => !classId || s.classId === classId), (s) => s.label)} /></Field>;
  if (name === 'examId')
    return (
      <Field label={label} required={required}>
        <Select value={value} onChange={(e) => onChange(e.target.value)} placeholder="Choose exam" options={(exams.data ?? []).filter((e) => e.status !== 'draft').map((e) => ({ value: e.id, label: `${e.name} (${e.yearName})` }))} />
      </Field>
    );
  if (name === 'academicYearIds')
    return (
      <Field label={label} className="sm:col-span-2">
        <div className="flex flex-wrap gap-3 pt-1.5">
          {years.data?.map((y) => (
            <Checkbox key={y.id} checked={(value ?? []).includes(y.id)} onChange={(on) => onChange(on ? [...(value ?? []), y.id] : value.filter((x: string) => x !== y.id))} label={y.name} />
          ))}
        </div>
      </Field>
    );
  if (name === 'studentId')
    return (
      <Field label={label} required={required} className="sm:col-span-2">
        <Input placeholder="Search student by name or admission no." value={studentSearch} onChange={(e) => setStudentSearch(e.target.value)} />
        {students.data && !value && (
          <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-slate-200 bg-white">
            {students.data.map((s) => (
              <li key={s.id}>
                <button type="button" className="w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50" onClick={() => (onChange(s.id), setStudentSearch(`${s.firstName} ${s.lastName} (${s.admissionNo})`))}>
                  {s.firstName} {s.lastName} <span className="text-slate-500">· {s.admissionNo}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {value && (
          <button type="button" className="mt-1 text-xs text-brand-700" onClick={() => (onChange(''), setStudentSearch(''))}>
            Clear
          </button>
        )}
      </Field>
    );
  if (schema.format === 'date' || name === 'from' || name === 'to') return <Field label={label}><Input type="date" value={value} onChange={(e) => onChange(e.target.value)} /></Field>;
  if (schema.type === 'boolean') return <Field label=" "><div className="pt-2"><Checkbox checked={!!value} onChange={onChange} label={label} /></div></Field>;
  if (enumValues) return <Field label={label}><Select value={value} onChange={(e) => onChange(e.target.value)} placeholder="Any" options={enumValues.map((v) => ({ value: v, label: titleCase(v) }))} /></Field>;
  if (schema.type === 'number') return <Field label={label}><Input type="number" value={value} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} /></Field>;
  return <Field label={label}><Input value={value} onChange={(e) => onChange(e.target.value)} /></Field>;
}
