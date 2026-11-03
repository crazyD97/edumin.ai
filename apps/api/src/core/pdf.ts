/**
 * Branded PDF documents (receipts, report cards, reports, timetables).
 * Every document gets the school's logo, name, contact line and colours.
 */
import PDFDocument from 'pdfkit';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { files, schools } from '../db/schema';
import { storage } from './storage';
import type { Branding } from '@edumin/shared';

export type Doc = InstanceType<typeof PDFDocument>;

export interface SchoolHeader {
  name: string;
  branding: Branding;
  logo: Buffer | null;
}

export async function loadSchoolHeader(schoolId: string): Promise<SchoolHeader> {
  const [s] = await db.select({ name: schools.name, branding: schools.branding }).from(schools).where(eq(schools.id, schoolId));
  let logo: Buffer | null = null;
  const m = s.branding.logoUrl?.match(/\/files\/([0-9a-f-]{36})/);
  if (m) {
    const [f] = await db.select().from(files).where(eq(files.id, m[1]));
    if (f && /png|jpe?g/.test(f.mimeType)) logo = await storage.get(f.storageKey).catch(() => null);
  }
  return { name: s.name, branding: s.branding, logo };
}

export function createDoc(opts: { landscape?: boolean } = {}) {
  return new PDFDocument({ size: 'A4', margin: 40, layout: opts.landscape ? 'landscape' : 'portrait', bufferPages: true });
}

export function toBuffer(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** Draws the letterhead; returns the y position below it. */
export function letterhead(doc: Doc, h: SchoolHeader, title: string, subtitle?: string | null) {
  const { primaryColor } = h.branding;
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  doc.rect(0, 0, doc.page.width, 6).fill(primaryColor);
  let x = left;
  const top = 24;
  if (h.logo) {
    try {
      doc.image(h.logo, left, top, { fit: [52, 52] });
      x = left + 62;
    } catch {
      /* unsupported image — skip logo */
    }
  }
  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(17).text(h.name, x, top, { width: width - (x - left) });
  const contact = [h.branding.address, h.branding.phone, h.branding.email, h.branding.website].filter(Boolean).join('  ·  ');
  if (contact) doc.font('Helvetica').fontSize(8.5).fillColor('#64748b').text(contact, x, doc.y + 2, { width: width - (x - left) });
  if (subtitle) doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#64748b').text(subtitle, x, doc.y + 2, { width: width - (x - left) });
  const y = Math.max(doc.y, top + 52) + 10;
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.8).strokeColor('#e2e8f0').stroke();
  doc.font('Helvetica-Bold').fontSize(13).fillColor(primaryColor).text(title.toUpperCase(), left, y + 12, { width, align: 'center', characterSpacing: 1 });
  doc.fillColor('#0f172a').font('Helvetica');
  return doc.y + 12;
}

/** Key/value grid in two columns. */
export function infoGrid(doc: Doc, y: number, pairs: [string, string | number | null | undefined][]) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const colW = width / 2;
  pairs.forEach(([k, v], i) => {
    const cx = left + (i % 2) * colW;
    const cy = y + Math.floor(i / 2) * 18;
    doc.font('Helvetica').fontSize(8.5).fillColor('#64748b').text(k, cx, cy, { width: 95 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0f172a').text(String(v ?? '—'), cx + 98, cy - 1, { width: colW - 104 });
  });
  return y + Math.ceil(pairs.length / 2) * 18 + 8;
}

export interface Col {
  label: string;
  width: number; // fraction of available width
  align?: 'left' | 'right' | 'center';
}

/** Simple paginating table with a tinted header row. */
export function table(doc: Doc, y: number, cols: Col[], rows: (string | number | null | undefined)[][], color = '#4f46e5', opts: { boldLast?: boolean } = {}) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const widths = cols.map((c) => c.width * width);
  const rowH = 18;
  const header = (yy: number) => {
    doc.rect(left, yy, width, rowH).fill(color);
    let cx = left;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#ffffff');
    cols.forEach((c, i) => {
      doc.text(c.label, cx + 5, yy + 5, { width: widths[i] - 10, align: c.align ?? 'left', lineBreak: false, ellipsis: true });
      cx += widths[i];
    });
    return yy + rowH;
  };
  y = header(y);
  rows.forEach((r, ri) => {
    if (y + rowH > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage();
      y = header(doc.page.margins.top);
    }
    if (ri % 2 === 1) doc.rect(left, y, width, rowH).fill('#f8fafc');
    let cx = left;
    const bold = opts.boldLast && ri === rows.length - 1;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor('#0f172a');
    r.forEach((cell, i) => {
      doc.text(cell === null || cell === undefined ? '—' : String(cell), cx + 5, y + 5, { width: widths[i] - 10, align: cols[i].align ?? 'left', lineBreak: false, ellipsis: true });
      cx += widths[i];
    });
    y += rowH;
  });
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  return y + 10;
}

export function footer(doc: Doc, h: SchoolHeader, text?: string | null) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const y = doc.page.height - 30;
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the margin must not trigger a page break
    doc.font('Helvetica').fontSize(7.5).fillColor('#94a3b8');
    doc.text(text ?? `Generated by ${h.name}`, left, y, { width: width * 0.75, lineBreak: false, ellipsis: true });
    doc.text(`Page ${i + 1} of ${range.count}`, left, y, { width, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

/** Standard PDF fonts lack the rupee glyph, so INR is written as "Rs.". */
export const fmtMoney = (n: number, currency = 'INR') =>
  `${currency === 'INR' ? 'Rs.' : currency} ${(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
