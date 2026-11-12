import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, GraduationCap, Plus, Upload, ArrowUpRight } from 'lucide-react';
import { STUDENT_STATUSES } from '@edumin/shared';
import { apiPage, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useClasses, useDebounced, useSections, useYears, toOptions } from '@/lib/hooks';
import { fmtDate, titleCase } from '@/lib/format';
import { Avatar, Badge, Button, Card, EmptyState, LinkButton, Menu, MenuItem, Modal, PageHeader, Select, StatusBadge } from '@/components/ui';
import { DataTable, Toolbar, type Column } from '@/components/DataTable';
import { StudentFormModal } from './StudentForm';

export function StudentsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ classId: '', sectionId: '', status: 'active', gender: '', academicYearId: '' });
  const [page, setPage] = useState(1);
  const [urlParams, setUrlParams] = useSearchParams();
  const [creating, setCreating] = useState(urlParams.get('new') === '1');
  const [importing, setImporting] = useState(false);
  const q = useDebounced(search);
  const years = useYears();
  const classes = useClasses();
  const sections = useSections(filters.academicYearId || undefined);
  const params = { ...filters, search: q, page, pageSize: 25 };
  const list = useQuery({ queryKey: ['students', params], queryFn: () => apiPage('/students', params), placeholderData: keepPreviousData });
  const setFilter = (k: keyof typeof filters) => (e: { target: { value: string } }) => {
    setFilters((f) => ({ ...f, [k]: e.target.value, ...(k === 'classId' ? { sectionId: '' } : {}) }));
    setPage(1);
  };

  const columns: Column<any>[] = [
    {
      key: 'name',
      header: 'Student',
      render: (s) => (
        <div className="flex items-center gap-3">
          <Avatar name={`${s.firstName} ${s.lastName}`} src={s.photoUrl} />
          <div>
            <p className="font-medium text-slate-900">
              {s.firstName} {s.lastName}
            </p>
            <p className="text-xs text-slate-500">{s.admissionNo}</p>
          </div>
        </div>
      ),
    },
    { key: 'class', header: 'Class', render: (s) => (s.className ? `${s.className} - ${s.sectionName}` : <Badge tone="amber">Not allocated</Badge>) },
    { key: 'rollNo', header: 'Roll', align: 'right', hideOnMobile: true },
    { key: 'gender', header: 'Gender', render: (s) => titleCase(s.gender) || '—', hideOnMobile: true },
    { key: 'dateOfBirth', header: 'Date of birth', render: (s) => fmtDate(s.dateOfBirth), hideOnMobile: true },
    { key: 'phone', header: 'Phone', hideOnMobile: true },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
  ];

  return (
    <>
      <PageHeader
        title="Students"
        description={list.data ? `${list.data.meta.total} students match your filters` : 'Search, filter and manage student records'}
        actions={
          <>
            {can('students.edit') && (
              <LinkButton to="/students/promote" icon={<ArrowUpRight className="size-4" />}>
                Promote
              </LinkButton>
            )}
            <Menu
              trigger={
                <Button variant="secondary" icon={<Download className="size-4" />}>
                  Import / Export
                </Button>
              }
            >
              {(close) => (
                <>
                  {can('students.create') && (
                    <MenuItem
                      icon={<Upload className="size-4" />}
                      onClick={() => {
                        close();
                        setImporting(true);
                      }}
                    >
                      Import from Excel/CSV
                    </MenuItem>
                  )}
                  {can('students.export') && (
                    <>
                      <MenuItem
                        icon={<FileSpreadsheet className="size-4" />}
                        onClick={() => {
                          close();
                          download('GET', '/students/export', undefined, { ...filters, search: q, format: 'xlsx' });
                        }}
                      >
                        Export to Excel
                      </MenuItem>
                      <MenuItem
                        icon={<Download className="size-4" />}
                        onClick={() => {
                          close();
                          download('GET', '/students/export', undefined, { ...filters, search: q, format: 'csv' });
                        }}
                      >
                        Export to CSV
                      </MenuItem>
                    </>
                  )}
                </>
              )}
            </Menu>
            {can('students.create') && (
              <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                Add student
              </Button>
            )}
          </>
        }
      />
      <Card padded={false}>
        <Toolbar
          search={search}
          onSearch={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Name, admission no. or phone"
        >
          <Select value={filters.academicYearId} onChange={setFilter('academicYearId')} placeholder="Current year" options={toOptions(years.data, (y) => y.name + (y.isCurrent ? ' (current)' : ''))} />
          <Select value={filters.classId} onChange={setFilter('classId')} placeholder="All classes" options={toOptions(classes.data, (c) => c.name)} />
          <Select
            value={filters.sectionId}
            onChange={setFilter('sectionId')}
            placeholder="All sections"
            options={toOptions(sections.data?.filter((s) => !filters.classId || s.classId === filters.classId), (s) => s.label)}
          />
          <Select value={filters.status} onChange={setFilter('status')} placeholder="Any status" options={STUDENT_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
          <Select value={filters.gender} onChange={setFilter('gender')} placeholder="Any gender" options={['male', 'female', 'other'].map((g) => ({ value: g, label: titleCase(g) }))} />
        </Toolbar>
        <DataTable
          columns={columns}
          rows={list.data?.rows}
          loading={list.isLoading}
          error={list.error}
          retry={list.refetch}
          rowKey={(s) => s.id}
          onRowClick={(s) => navigate(`/students/${s.id}`)}
          pagination={list.data ? { page, pageSize: 25, total: list.data.meta.total, onPage: setPage } : undefined}
          empty={
            <EmptyState
              icon={<GraduationCap className="size-5" />}
              title="No students found"
              description={search || filters.classId ? 'Try a different search or filter.' : 'Register your first student or import a spreadsheet.'}
              action={can('students.create') && <Button onClick={() => setCreating(true)}>Add student</Button>}
            />
          }
        />
      </Card>
      <StudentFormModal open={creating} onClose={() => (setCreating(false), urlParams.has('new') && setUrlParams({}))} onSaved={(id) => navigate(`/students/${id}`)} />
      <ImportModal open={importing} onClose={() => setImporting(false)} />
    </>
  );
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ valid: number; imported: number; errors: { row: number; message: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/students/import?dryRun=${dryRun}`, { method: 'POST', body: fd, credentials: 'include' });
      const j = await res.json();
      if (!j.success) throw new Error(j.error.message);
      setResult(j.data);
      if (!dryRun) qc.invalidateQueries({ queryKey: ['students'] });
    } catch (e) {
      setResult({ valid: 0, imported: 0, errors: [{ row: 0, message: (e as Error).message }] });
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setFile(null);
    setResult(null);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="Import students"
      description="Upload an Excel (.xlsx) or CSV file. Rows are validated before anything is saved."
      footer={
        result?.imported ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" disabled={!file} loading={busy} onClick={() => run(true)}>
              Validate
            </Button>
            <Button disabled={!file || !result || result.errors.length > 0 || result.valid === 0} loading={busy} onClick={() => run(false)}>
              Import {result?.valid ? `${result.valid} students` : ''}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <button type="button" onClick={() => download('GET', '/students/import-template')} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
          <FileSpreadsheet className="size-4" /> Download the template
        </button>
        <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 px-4 py-8 text-center hover:border-brand hover:bg-brand-50/40">
          <Upload className="mb-2 size-6 text-slate-400" />
          <span className="text-sm font-medium text-slate-700">{file ? file.name : 'Choose a file'}</span>
          <span className="text-xs text-slate-500">.xlsx or .csv · up to 2000 rows</span>
          <input
            type="file"
            accept=".xlsx,.csv"
            className="hidden"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
            }}
          />
        </label>
        {result && (
          <div className={result.errors.length ? 'rounded-lg bg-red-50 p-3' : 'rounded-lg bg-emerald-50 p-3'}>
            {result.imported ? (
              <p className="text-sm font-medium text-emerald-800">Imported {result.imported} students.</p>
            ) : result.errors.length ? (
              <>
                <p className="mb-2 text-sm font-medium text-red-800">{result.errors.length} problem(s) found — fix the file and validate again.</p>
                <ul className="max-h-48 space-y-1 overflow-y-auto text-xs text-red-700">
                  {result.errors.map((e, i) => (
                    <li key={i}>
                      {e.row ? `Row ${e.row}: ` : ''}
                      {e.message}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm font-medium text-emerald-800">All {result.valid} rows look good. Ready to import.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
