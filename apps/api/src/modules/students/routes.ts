import { z } from 'zod';
import ExcelJS from 'exceljs';
import { and, eq, inArray } from 'drizzle-orm';
import { students } from '../../db/schema';
import { ownStudentIds } from '../../core/context';
import { STUDENT_STATUSES } from '@edumin/shared';
import { badRequest } from '../../core/errors';
import { ctxOf, guard, idParam, ok, sendFile, typed, type App } from '../../core/http';
import { MIME, toCsv, toXlsx } from '../../core/export';
import {
  IMPORT_COLUMNS,
  changeStatus,
  createPortalAccount,
  createStudent,
  getStudent,
  importStudents,
  listQuery,
  listStudents,
  promote,
  promoteInput,
  studentInput,
  updateStudent,
} from './service';

async function parseSheet(buf: Buffer, filename: string): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  if (filename.toLowerCase().endsWith('.csv')) {
    const { Readable } = await import('node:stream');
    await wb.csv.read(Readable.from(buf.toString('utf8').replace(/^﻿/, '')));
  } else {
    await wb.xlsx.load(buf as any);
  }
  const ws = wb.worksheets[0];
  if (!ws) throw badRequest('The file has no sheets');
  const header = (ws.getRow(1).values as unknown[]).slice(1).map((h) => String(h ?? '').trim());
  const out: Record<string, string>[] = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const vals = (row.values as unknown[]).slice(1);
    const rec: Record<string, string> = {};
    header.forEach((h, j) => {
      const v = vals[j] as any;
      rec[h] = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'object' && 'text' in v ? String(v.text) : String(v);
    });
    if (Object.values(rec).some((v) => v.trim())) out.push(rec);
  });
  return out;
}

export async function studentRoutes(app: App) {
  const r = typed(app);

  r.get('/students', { preValidation: guard('students.view'), schema: { tags: ['Students'], querystring: listQuery } }, async (req) => {
    const { rows, total } = await listStudents(ctxOf(req), req.query);
    return ok(rows, { page: req.query.page, pageSize: req.query.pageSize, total });
  });

  r.get(
    '/students/export',
    { preValidation: guard(['students.view', 'students.export']), schema: { tags: ['Students'], querystring: listQuery.extend({ format: z.enum(['csv', 'xlsx']).default('xlsx') }) } },
    async (req, reply) => {
      const { rows } = await listStudents(ctxOf(req), { ...req.query, page: 1, pageSize: 100000 });
      const report = {
        title: 'Students',
        columns: [
          { key: 'admissionNo', label: 'Admission No' },
          { key: 'name', label: 'Name' },
          { key: 'className', label: 'Class' },
          { key: 'sectionName', label: 'Section' },
          { key: 'rollNo', label: 'Roll No' },
          { key: 'gender', label: 'Gender' },
          { key: 'dateOfBirth', label: 'Date of Birth' },
          { key: 'phone', label: 'Phone' },
          { key: 'email', label: 'Email' },
          { key: 'status', label: 'Status' },
        ],
        rows: rows.map((s) => ({ ...s, name: `${s.firstName} ${s.lastName}`.trim() })),
      };
      const f = req.query.format;
      return sendFile(reply, f === 'csv' ? toCsv(report) : await toXlsx(report), `students.${f}`, MIME[f]);
    },
  );

  r.get('/students/import-template', { preValidation: guard('students.create'), schema: { tags: ['Students'] } }, async (_req, reply) => {
    const report = {
      title: 'Students',
      columns: IMPORT_COLUMNS.map((c) => ({ key: c, label: c })),
      rows: [
        {
          firstName: 'Aarav',
          lastName: 'Sharma',
          gender: 'male',
          dateOfBirth: '2015-06-21',
          phone: '9876500000',
          class: 'Grade 5',
          section: 'A',
          guardianName: 'Rohit Sharma',
          guardianRelation: 'father',
          guardianPhone: '9876500001',
          guardianEmail: 'rohit@example.com',
        },
      ],
    };
    return sendFile(reply, await toXlsx(report), 'student-import-template.xlsx', MIME.xlsx);
  });

  r.post(
    '/students/import',
    { preValidation: guard('students.create'), schema: { tags: ['Students'], summary: 'multipart CSV/XLSX upload', querystring: z.object({ dryRun: z.enum(['true', 'false']).default('true') }) } },
    async (req) => {
      const part = await req.file({ limits: { fileSize: 5 * 1024 * 1024 } });
      if (!part) throw badRequest('Upload a CSV or Excel file');
      const rows = await parseSheet(await part.toBuffer(), part.filename);
      if (!rows.length) throw badRequest('The file contains no data rows');
      if (rows.length > 2000) throw badRequest('Import at most 2000 students at a time');
      return ok(await importStudents(ctxOf(req), rows, req.query.dryRun === 'true'));
    },
  );

  /** The caller's own student record(s): themself, or a parent's children. */
  r.get('/students/mine', { preValidation: guard(), schema: { tags: ['Students'] } }, async (req) => {
    const ctx = ctxOf(req);
    const ids = await ownStudentIds(ctx);
    if (!ids.length) return ok([]);
    const rows = await ctx.db
      .select({ id: students.id, firstName: students.firstName, lastName: students.lastName, admissionNo: students.admissionNo, photoUrl: students.photoUrl })
      .from(students)
      .where(and(eq(students.schoolId, ctx.schoolId), inArray(students.id, ids)));
    return ok(rows);
  });

  r.post('/students/promote', { preValidation: guard('students.edit'), schema: { tags: ['Students'], body: promoteInput } }, async (req) => ok(await promote(ctxOf(req), req.body)));

  r.get('/students/:id', { preValidation: guard('students.view'), schema: { tags: ['Students'], params: idParam } }, async (req) => ok(await getStudent(ctxOf(req), req.params.id)));

  r.post('/students', { preValidation: guard('students.create'), schema: { tags: ['Students'], body: studentInput } }, async (req) => {
    const s = await createStudent(ctxOf(req), req.body);
    return ok({ id: s.id, admissionNo: s.admissionNo });
  });

  r.put('/students/:id', { preValidation: guard('students.edit'), schema: { tags: ['Students'], params: idParam, body: studentInput } }, async (req) => {
    await updateStudent(ctxOf(req), req.params.id, req.body);
    return ok({ updated: true });
  });

  r.post(
    '/students/:id/status',
    {
      preValidation: guard('students.edit'),
      schema: { tags: ['Students'], summary: 'Transfer, withdraw, deactivate or reactivate', params: idParam, body: z.object({ status: z.enum(STUDENT_STATUSES), date: z.iso.date().nullish(), reason: z.string().nullish() }) },
    },
    async (req) => {
      await changeStatus(ctxOf(req), req.params.id, req.body);
      return ok({ updated: true });
    },
  );

  r.post(
    '/students/:id/portal-account',
    { preValidation: guard('students.edit'), schema: { tags: ['Students'], params: idParam, body: z.object({ email: z.email(), password: z.string().min(8) }) } },
    async (req) => ok(await createPortalAccount(ctxOf(req), 'student', req.params.id, req.body.email, req.body.password)),
  );

  r.post(
    '/guardians/:id/portal-account',
    { preValidation: guard('students.edit'), schema: { tags: ['Students'], params: idParam, body: z.object({ email: z.email(), password: z.string().min(8) }) } },
    async (req) => ok(await createPortalAccount(ctxOf(req), 'parent', req.params.id, req.body.email, req.body.password)),
  );
}
