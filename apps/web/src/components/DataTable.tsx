import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { clsx, EmptyState, ErrorState, Skeleton } from './ui';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  /** Hide below the `md` breakpoint to keep tables readable on phones. */
  hideOnMobile?: boolean;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}

export function DataTable<T>({
  columns,
  rows,
  loading,
  error,
  retry,
  rowKey,
  onRowClick,
  empty,
  pagination,
  footer,
  dense,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  error?: unknown;
  retry?: () => void;
  rowKey: (row: T, i: number) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  pagination?: Pagination;
  footer?: ReactNode;
  dense?: boolean;
}) {
  const alignCls = (a?: string) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');
  if (error) return <ErrorState error={error} retry={retry} />;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="border-b border-slate-200 bg-slate-50/70">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={clsx('th', alignCls(c.align), c.hideOnMobile && 'hidden md:table-cell', c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && !rows?.length
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c.key} className={clsx('td', c.hideOnMobile && 'hidden md:table-cell')}>
                        <Skeleton className="h-4 w-3/4" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows?.map((row, i) => (
                  <tr key={rowKey(row, i)} onClick={onRowClick ? () => onRowClick(row) : undefined} className={clsx('transition', onRowClick && 'cursor-pointer hover:bg-slate-50')}>
                    {columns.map((c) => (
                      <td key={c.key} className={clsx('td', dense && 'py-2', alignCls(c.align), c.hideOnMobile && 'hidden md:table-cell', c.className)}>
                        {c.render ? c.render(row, i) : ((row as any)[c.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
          {footer}
        </table>
      </div>
      {!loading && rows && rows.length === 0 && (empty ?? <EmptyState title="Nothing here yet" description="Try adjusting your filters." />)}
      {pagination && pagination.total > 0 && <Pager {...pagination} />}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: Pagination) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-500">
      <span>
        <span className="font-medium text-slate-700">{from}</span>–<span className="font-medium text-slate-700">{to}</span> of <span className="font-medium text-slate-700">{total}</span>
      </span>
      <div className="flex items-center gap-1">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded-md p-1.5 hover:bg-slate-100 disabled:opacity-40" aria-label="Previous page">
          <ChevronLeft className="size-4" />
        </button>
        <span className="px-2 tabular-nums">
          {page} / {pages}
        </span>
        <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} className="rounded-md p-1.5 hover:bg-slate-100 disabled:opacity-40" aria-label="Next page">
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** Search + filter row that sits above a table. */
export function Toolbar({ search, onSearch, placeholder = 'Search…', children }: { search?: string; onSearch?: (v: string) => void; placeholder?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-slate-100 p-3 sm:flex-row sm:flex-wrap sm:items-center">
      {onSearch && (
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" value={search ?? ''} onChange={(e) => onSearch(e.target.value)} placeholder={placeholder} />
        </div>
      )}
      {children && <div className="flex flex-wrap items-center gap-2 [&_.input]:w-auto [&_.input]:min-w-36">{children}</div>}
    </div>
  );
}
