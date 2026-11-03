/** Turns a ReportResult into CSV, Excel or a branded PDF. */
import ExcelJS from 'exceljs';
import type { ReportResult } from '@edumin/shared';
import { createDoc, footer, letterhead, loadSchoolHeader, table, toBuffer } from './pdf';

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

const cell = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : v);

export function toCsv(r: ReportResult) {
  const esc = (v: unknown) => {
    const s = String(cell(v));
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [r.columns.map((c) => esc(c.label)).join(','), ...r.rows.map((row) => r.columns.map((c) => esc(row[c.key])).join(','))];
  return '﻿' + lines.join('\r\n');
}

export async function toXlsx(r: ReportResult) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(r.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  ws.columns = r.columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(12, c.label.length + 4) }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  for (const row of r.rows) ws.addRow(Object.fromEntries(r.columns.map((c) => [c.key, cell(row[c.key])])));
  r.columns.forEach((c, i) => {
    if (c.type === 'currency') ws.getColumn(i + 1).numFmt = '#,##0.00';
    if (c.type === 'percent') ws.getColumn(i + 1).numFmt = '0.0"%"';
  });
  if (r.summary?.length) {
    ws.addRow([]);
    for (const s of r.summary) ws.addRow([s.label, s.value]).font = { bold: true };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function toPdf(r: ReportResult, schoolId: string) {
  const h = await loadSchoolHeader(schoolId);
  const doc = createDoc({ landscape: r.columns.length > 6 });
  let y = letterhead(doc, h, r.title, r.description);
  if (r.summary?.length) {
    doc.font('Helvetica').fontSize(9).fillColor('#334155');
    doc.text(r.summary.map((s) => `${s.label}: ${s.value}`).join('   |   '), doc.page.margins.left, y, { width: doc.page.width - 80 });
    y = doc.y + 8;
  }
  const w = 1 / r.columns.length;
  table(
    doc,
    y,
    r.columns.map((c) => ({ label: c.label, width: w, align: c.type && c.type !== 'text' && c.type !== 'date' ? 'right' : 'left' })),
    r.rows.map((row) => r.columns.map((c) => fmtCell(row[c.key], c.type))),
    h.branding.primaryColor,
  );
  footer(doc, h, `${h.name} · Generated ${new Date().toLocaleString('en-IN')}`);
  return toBuffer(doc);
}

function fmtCell(v: unknown, type?: string) {
  if (v === null || v === undefined || v === '') return '—';
  if (type === 'currency' && typeof v === 'number') return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (type === 'percent' && typeof v === 'number') return `${v.toFixed(1)}%`;
  return String(cell(v));
}

export async function exportReport(r: ReportResult, format: ExportFormat, schoolId: string): Promise<Buffer | string> {
  if (format === 'csv') return toCsv(r);
  if (format === 'xlsx') return toXlsx(r);
  return toPdf(r, schoolId);
}
