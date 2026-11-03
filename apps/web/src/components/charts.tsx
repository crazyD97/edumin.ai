/**
 * Chart wrappers (Recharts). Series colours come from the validated
 * categorical order — slot 1, 2, 3 — and follow the series, never its rank.
 * Thin marks, recessive grid, a tooltip on every chart, and a legend
 * whenever there are two or more series.
 */
import type { ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];
const AXIS = { stroke: '#94a3b8', fontSize: 11, tickLine: false, axisLine: false } as const;
const GRID = <CartesianGrid stroke="#eef2f6" vertical={false} />;

export interface Series {
  key: string;
  label: string;
}

function ChartTooltip({ active, payload, label, format }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-slate-900">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="flex items-center gap-2 text-slate-600">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          {p.name}: <span className="font-medium text-slate-900 tabular-nums">{format ? format(p.value) : p.value}</span>
        </p>
      ))}
    </div>
  );
}

const legend = (n: number) => (n >= 2 ? <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: '#475569', paddingTop: 8 }} /> : null);

export function TrendChart({ data, xKey, series, height = 240, format, yDomain, area }: { data: any[]; xKey: string; series: Series[]; height?: number; format?: (v: number) => string; yDomain?: [number | 'auto', number | 'auto']; area?: boolean }) {
  if (area && series.length === 1) {
    const s = series[0];
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.18} />
              <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0} />
            </linearGradient>
          </defs>
          {GRID}
          <XAxis dataKey={xKey} {...AXIS} minTickGap={18} />
          <YAxis {...AXIS} domain={yDomain ?? ['auto', 'auto']} tickFormatter={format} width={56} />
          <Tooltip content={<ChartTooltip format={format} />} cursor={{ stroke: '#cbd5e1' }} />
          <Area type="monotone" dataKey={s.key} name={s.label} stroke={SERIES[0]} strokeWidth={2} fill={`url(#g-${s.key})`} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
        </AreaChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        {GRID}
        <XAxis dataKey={xKey} {...AXIS} minTickGap={18} />
        <YAxis {...AXIS} domain={yDomain ?? ['auto', 'auto']} tickFormatter={format} width={56} />
        <Tooltip content={<ChartTooltip format={format} />} cursor={{ stroke: '#cbd5e1' }} />
        {legend(series.length)}
        {series.map((s, i) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={SERIES[i % SERIES.length]} strokeWidth={2} dot={data.length < 16 ? { r: 3 } : false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function BarsChart({ data, xKey, series, height = 240, format, horizontal }: { data: any[]; xKey: string; series: Series[]; height?: number; format?: (v: number) => string; horizontal?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 8, left: horizontal ? 8 : -12, bottom: 0 }} barGap={2} barCategoryGap="28%">
        <CartesianGrid stroke="#eef2f6" vertical={!!horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" {...AXIS} tickFormatter={format} />
            <YAxis type="category" dataKey={xKey} {...AXIS} width={110} />
          </>
        ) : (
          <>
            <XAxis dataKey={xKey} {...AXIS} interval={0} angle={data.length > 8 ? -30 : 0} textAnchor={data.length > 8 ? 'end' : 'middle'} height={data.length > 8 ? 52 : 28} />
            <YAxis {...AXIS} tickFormatter={format} width={56} />
          </>
        )}
        <Tooltip content={<ChartTooltip format={format} />} cursor={{ fill: '#f1f5f9' }} />
        {legend(series.length)}
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={SERIES[i % SERIES.length]} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={36} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ChartEmpty({ children = 'No data for this period yet' }: { children?: ReactNode }) {
  return <div className="grid h-[200px] place-items-center text-sm text-slate-400">{children}</div>;
}
