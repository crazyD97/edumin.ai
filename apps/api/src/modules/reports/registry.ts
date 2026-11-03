/**
 * Report registry.
 *
 * Each report is a named, typed, permission-checked function returning a
 * `ReportResult`. The HTTP layer lists, runs and exports them generically, and
 * a future MCP server can expose each entry as a tool with `params` as its
 * input schema — no SQL ever leaves this layer.
 */
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { FeatureKey, Permission, ReportResult } from '@edumin/shared';
import {
  academicYears,
  admissionApplications,
  admissionEnquiries,
  attendanceRecords,
  classes,
  enrollments,
  exams,
  feeHeads,
  feeInvoices,
  payments,
  sectionSubjects,
  sections,
  staffAttendance,
  students,
  timetableEntries,
  users,
  roles,
} from '../../db/schema';
import { requireFeature, requirePermission, scopedStudentIds, type Ctx } from '../../core/context';
import { badRequest } from '../../core/errors';
import { resolveYearId } from '../academics/routes';
import { listStudents } from '../students/service';
import { ATTENDANCE_SCORE, attendanceStats } from '../attendance/service';
import { BALANCE } from '../fees/service';
import { computeResults, examResults, studentHistory } from '../exams/service';

export interface ReportDef<P extends z.ZodType = z.ZodType> {
  key: string;
  name: string;
  description: string;
  category: 'Students' | 'Attendance' | 'Fees' | 'Admissions' | 'Examinations' | 'Staff' | 'Academic';
  permission: Permission;
  feature?: FeatureKey;
  params: P;
  run: (ctx: Ctx, params: z.infer<P>) => Promise<ReportResult>;
}

const define = <P extends z.ZodType>(d: ReportDef<P>) => d as unknown as ReportDef;

const uuid = z.uuid();
const optUuid = z.preprocess((v) => (v === '' ? undefined : v), z.uuid().optional());
const isoDate = z.iso.date();
const today = () => new Date().toISOString().slice(0, 10);
const monthAgo = () => new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
const NONE = ['00000000-0000-0000-0000-000000000000'];

async function yearRange(ctx: Ctx, yearId?: string) {
  const id = await resolveYearId(ctx, yearId);
  const [y] = await ctx.db.select().from(academicYears).where(eq(academicYears.id, id));
  return y;
}

export const reports: ReportDef[] = [
  define({
    key: 'students',
    name: 'Student list',
    description: 'Students with class, section and contact details. Filter by year, class, section, status and gender.',
    category: 'Students',
    permission: 'students.view',
    params: z.object({
      academicYearId: optUuid,
      classId: optUuid,
      sectionId: optUuid,
      status: z.enum(['active', 'inactive', 'transferred', 'withdrawn', 'graduated']).optional(),
      gender: z.enum(['male', 'female', 'other']).optional(),
    }),
    async run(ctx, p) {
      const { rows } = await listStudents(ctx, { ...p, page: 1, pageSize: 100000 });
      const byGender = rows.reduce<Record<string, number>>((a, r) => ((a[r.gender ?? 'unspecified'] = (a[r.gender ?? 'unspecified'] ?? 0) + 1), a), {});
      return {
        title: 'Student List',
        columns: [
          { key: 'admissionNo', label: 'Admission No' },
          { key: 'name', label: 'Name' },
          { key: 'className', label: 'Class' },
          { key: 'sectionName', label: 'Section' },
          { key: 'rollNo', label: 'Roll', type: 'number' },
          { key: 'gender', label: 'Gender' },
          { key: 'dateOfBirth', label: 'DOB', type: 'date' },
          { key: 'phone', label: 'Phone' },
          { key: 'status', label: 'Status' },
        ],
        rows: rows.map((r) => ({ ...r, name: `${r.firstName} ${r.lastName}`.trim() })),
        summary: [{ label: 'Total', value: rows.length }, ...Object.entries(byGender).map(([k, v]) => ({ label: k[0].toUpperCase() + k.slice(1), value: v }))],
      };
    },
  }),

  define({
    key: 'attendance-summary',
    name: 'Attendance summary',
    description: 'Per-student attendance percentage for a date range. Set a threshold (e.g. 75) to list only students below it.',
    category: 'Attendance',
    permission: 'attendance.view',
    feature: 'attendance',
    params: z.object({ from: isoDate.default(monthAgo), to: isoDate.default(today), classId: optUuid, sectionId: optUuid, studentId: optUuid, below: z.coerce.number().min(0).max(100).optional() }),
    async run(ctx, p) {
      let rows = await attendanceStats(ctx, { from: p.from, to: p.to, classId: p.classId, sectionId: p.sectionId, studentIds: p.studentId ? [p.studentId] : null });
      if (p.below !== undefined) rows = rows.filter((r) => r.percentage < p.below!);
      const avg = rows.length ? rows.reduce((a, r) => a + r.percentage, 0) / rows.length : 0;
      return {
        title: p.below !== undefined ? `Students below ${p.below}% attendance` : 'Attendance Summary',
        description: `${p.from} to ${p.to}`,
        columns: [
          { key: 'admissionNo', label: 'Admission No' },
          { key: 'name', label: 'Name' },
          { key: 'className', label: 'Class' },
          { key: 'sectionName', label: 'Section' },
          { key: 'total', label: 'Days', type: 'number' },
          { key: 'present', label: 'Present', type: 'number' },
          { key: 'absent', label: 'Absent', type: 'number' },
          { key: 'late', label: 'Late', type: 'number' },
          { key: 'halfDay', label: 'Half day', type: 'number' },
          { key: 'percentage', label: 'Attendance %', type: 'percent' },
        ],
        rows,
        summary: [
          { label: 'Students', value: rows.length },
          { label: 'Average', value: `${avg.toFixed(1)}%` },
        ],
      };
    },
  }),

  define({
    key: 'attendance-daily',
    name: 'Daily attendance trend',
    description: 'School-wide (or class-wise) attendance percentage for each day in a range.',
    category: 'Attendance',
    permission: 'attendance.view',
    feature: 'attendance',
    params: z.object({ from: isoDate.default(monthAgo), to: isoDate.default(today), classId: optUuid, sectionId: optUuid }),
    async run(ctx, p) {
      const scoped = await scopedStudentIds(ctx);
      const rows = await ctx.db
        .select({
          date: attendanceRecords.date,
          marked: sql<number>`count(*)::int`,
          present: sql<number>`count(*) filter (where ${attendanceRecords.status} in ('present','late'))::int`,
          absent: sql<number>`count(*) filter (where ${attendanceRecords.status} = 'absent')::int`,
          percentage: sql<number>`round(100.0 * sum(${ATTENDANCE_SCORE}) / nullif(count(*),0), 1)::float`,
        })
        .from(attendanceRecords)
        .innerJoin(sections, eq(sections.id, attendanceRecords.sectionId))
        .where(
          and(
            eq(attendanceRecords.schoolId, ctx.schoolId),
            gte(attendanceRecords.date, p.from),
            lte(attendanceRecords.date, p.to),
            p.classId ? eq(sections.classId, p.classId) : undefined,
            p.sectionId ? eq(sections.id, p.sectionId) : undefined,
            scoped ? inArray(attendanceRecords.studentId, scoped.length ? scoped : NONE) : undefined,
          ),
        )
        .groupBy(attendanceRecords.date)
        .orderBy(asc(attendanceRecords.date));
      return {
        title: 'Daily Attendance',
        description: `${p.from} to ${p.to}`,
        columns: [
          { key: 'date', label: 'Date', type: 'date' },
          { key: 'marked', label: 'Marked', type: 'number' },
          { key: 'present', label: 'Present', type: 'number' },
          { key: 'absent', label: 'Absent', type: 'number' },
          { key: 'percentage', label: 'Attendance %', type: 'percent' },
        ],
        rows,
        chart: { type: 'line', xKey: 'date', series: [{ key: 'percentage', label: 'Attendance %' }] },
      };
    },
  }),

  define({
    key: 'attendance-compare-years',
    name: 'Attendance by academic year',
    description: 'Compare attendance percentage class-by-class across two or more academic years.',
    category: 'Attendance',
    permission: 'attendance.view',
    feature: 'attendance',
    params: z.object({ academicYearIds: z.array(uuid).min(1).optional() }),
    async run(ctx, p) {
      const years = await ctx.db
        .select()
        .from(academicYears)
        .where(and(eq(academicYears.schoolId, ctx.schoolId), p.academicYearIds?.length ? inArray(academicYears.id, p.academicYearIds) : undefined))
        .orderBy(asc(academicYears.startDate));
      const scoped = await scopedStudentIds(ctx);
      const data = await ctx.db
        .select({
          yearId: sections.academicYearId,
          className: classes.name,
          level: classes.level,
          percentage: sql<number>`round(100.0 * sum(${ATTENDANCE_SCORE}) / nullif(count(*),0), 1)::float`,
        })
        .from(attendanceRecords)
        .innerJoin(sections, eq(sections.id, attendanceRecords.sectionId))
        .innerJoin(classes, eq(classes.id, sections.classId))
        .where(and(eq(attendanceRecords.schoolId, ctx.schoolId), inArray(sections.academicYearId, years.map((y) => y.id).concat(NONE)), scoped ? inArray(attendanceRecords.studentId, scoped.length ? scoped : NONE) : undefined))
        .groupBy(sections.academicYearId, classes.name, classes.level)
        .orderBy(asc(classes.level));
      const byClass = new Map<string, Record<string, unknown>>();
      for (const d of data) {
        const row = byClass.get(d.className) ?? { className: d.className };
        row[`y_${d.yearId}`] = d.percentage;
        byClass.set(d.className, row);
      }
      return {
        title: 'Attendance Comparison by Academic Year',
        columns: [{ key: 'className', label: 'Class' }, ...years.map((y) => ({ key: `y_${y.id}`, label: y.name, type: 'percent' as const }))],
        rows: [...byClass.values()],
        chart: { type: 'bar', xKey: 'className', series: years.map((y) => ({ key: `y_${y.id}`, label: y.name })) },
      };
    },
  }),

  define({
    key: 'fee-collection',
    name: 'Fee collection',
    description: 'Payments received in a date range, with totals by payment method. Use for daily cash reports or monthly collection (e.g. all of March).',
    category: 'Fees',
    permission: 'fees.view',
    feature: 'fees',
    params: z.object({ from: isoDate.default(monthAgo), to: isoDate.default(today), method: z.string().optional(), classId: optUuid }),
    async run(ctx, p) {
      const rows = await ctx.db
        .select({
          receiptNo: payments.receiptNo,
          paidAt: sql<string>`to_char(${payments.paidAt}, 'YYYY-MM-DD')`,
          admissionNo: students.admissionNo,
          name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
          className: sql<string | null>`(select c.name || ' - ' || s.name from enrollments e join sections s on s.id = e.section_id join classes c on c.id = s.class_id join academic_years y on y.id = e.academic_year_id and y.is_current where e.student_id = ${students.id} limit 1)`,
          method: payments.method,
          reference: payments.reference,
          amount: payments.amount,
          receivedBy: users.fullName,
        })
        .from(payments)
        .innerJoin(students, eq(students.id, payments.studentId))
        .leftJoin(users, eq(users.id, payments.receivedBy))
        .where(
          and(
            eq(payments.schoolId, ctx.schoolId),
            eq(payments.status, 'completed'),
            gte(payments.paidAt, new Date(p.from + 'T00:00:00')),
            lte(payments.paidAt, new Date(p.to + 'T23:59:59.999')),
            p.method ? eq(payments.method, p.method) : undefined,
            p.classId
              ? sql`exists (select 1 from enrollments e join sections s on s.id = e.section_id join academic_years y on y.id = e.academic_year_id and y.is_current where e.student_id = ${students.id} and s.class_id = ${p.classId})`
              : undefined,
          ),
        )
        .orderBy(asc(payments.paidAt));
      const total = rows.reduce((a, r) => a + r.amount, 0);
      const byMethod = rows.reduce<Record<string, number>>((a, r) => ((a[r.method] = (a[r.method] ?? 0) + r.amount), a), {});
      return {
        title: 'Fee Collection Report',
        description: `${p.from} to ${p.to}`,
        columns: [
          { key: 'paidAt', label: 'Date', type: 'date' },
          { key: 'receiptNo', label: 'Receipt' },
          { key: 'admissionNo', label: 'Admission No' },
          { key: 'name', label: 'Student' },
          { key: 'className', label: 'Class' },
          { key: 'method', label: 'Method' },
          { key: 'reference', label: 'Reference' },
          { key: 'amount', label: 'Amount', type: 'currency' },
        ],
        rows,
        summary: [
          { label: 'Receipts', value: rows.length },
          { label: 'Total collected', value: total.toFixed(2) },
          ...Object.entries(byMethod).map(([k, v]) => ({ label: k.replace('_', ' '), value: v.toFixed(2) })),
        ],
      };
    },
  }),

  define({
    key: 'fee-collection-by-head',
    name: 'Collection by fee head',
    description: 'How much was billed, collected and is outstanding per fee head for an academic year.',
    category: 'Fees',
    permission: 'fees.view',
    feature: 'fees',
    params: z.object({ academicYearId: optUuid }),
    async run(ctx, p) {
      const yearId = await resolveYearId(ctx, p.academicYearId);
      const rows = await ctx.db
        .select({
          head: sql<string>`coalesce(${feeHeads.name}, 'Other')`,
          invoices: sql<number>`count(*)::int`,
          billed: sql<number>`sum(${feeInvoices.amount})::float`,
          concessions: sql<number>`sum(${feeInvoices.discount} + ${feeInvoices.scholarship})::float`,
          collected: sql<number>`sum(${feeInvoices.paid})::float`,
          outstanding: sql<number>`sum(${BALANCE})::float`,
        })
        .from(feeInvoices)
        .leftJoin(feeHeads, eq(feeHeads.id, feeInvoices.feeHeadId))
        .where(and(eq(feeInvoices.schoolId, ctx.schoolId), eq(feeInvoices.academicYearId, yearId), sql`${feeInvoices.status} <> 'cancelled'`))
        .groupBy(feeHeads.name)
        .orderBy(desc(sql`3`));
      return {
        title: 'Fee Collection by Head',
        columns: [
          { key: 'head', label: 'Fee head' },
          { key: 'invoices', label: 'Invoices', type: 'number' },
          { key: 'billed', label: 'Billed', type: 'currency' },
          { key: 'concessions', label: 'Concessions', type: 'currency' },
          { key: 'collected', label: 'Collected', type: 'currency' },
          { key: 'outstanding', label: 'Outstanding', type: 'currency' },
        ],
        rows,
        chart: { type: 'bar', xKey: 'head', series: [{ key: 'collected', label: 'Collected' }, { key: 'outstanding', label: 'Outstanding' }] },
      };
    },
  }),

  define({
    key: 'fee-pending',
    name: 'Pending fees / defaulters',
    description: 'Students with outstanding fee balances. Set overdueOnly to list defaulters past their due date.',
    category: 'Fees',
    permission: 'fees.view',
    feature: 'fees',
    params: z.object({ academicYearId: optUuid, classId: optUuid, sectionId: optUuid, overdueOnly: z.coerce.boolean().default(false), minBalance: z.coerce.number().min(0).default(0) }),
    async run(ctx, p) {
      const yearId = await resolveYearId(ctx, p.academicYearId);
      const scoped = await scopedStudentIds(ctx);
      const rows = await ctx.db
        .select({
          admissionNo: students.admissionNo,
          name: sql<string>`max(${students.firstName} || ' ' || ${students.lastName})`,
          className: sql<string>`max(${classes.name})`,
          sectionName: sql<string>`max(${sections.name})`,
          phone: sql<string>`max(coalesce(${students.phone}, ''))`,
          invoices: sql<number>`count(*)::int`,
          oldestDue: sql<string>`min(${feeInvoices.dueDate})`,
          balance: sql<number>`sum(${BALANCE})::float`,
        })
        .from(feeInvoices)
        .innerJoin(students, eq(students.id, feeInvoices.studentId))
        .leftJoin(enrollments, and(eq(enrollments.studentId, students.id), eq(enrollments.academicYearId, feeInvoices.academicYearId)))
        .leftJoin(sections, eq(sections.id, enrollments.sectionId))
        .leftJoin(classes, eq(classes.id, sections.classId))
        .where(
          and(
            eq(feeInvoices.schoolId, ctx.schoolId),
            eq(feeInvoices.academicYearId, yearId),
            inArray(feeInvoices.status, ['unpaid', 'partial']),
            p.overdueOnly ? sql`${feeInvoices.dueDate} < ${today()}` : undefined,
            p.classId ? eq(sections.classId, p.classId) : undefined,
            p.sectionId ? eq(sections.id, p.sectionId) : undefined,
            scoped ? inArray(students.id, scoped.length ? scoped : NONE) : undefined,
          ),
        )
        .groupBy(students.admissionNo)
        .having(sql`sum(${BALANCE}) > ${p.minBalance}`)
        .orderBy(desc(sql`sum(${BALANCE})`));
      const total = rows.reduce((a, r) => a + r.balance, 0);
      return {
        title: p.overdueOnly ? 'Fee Defaulters' : 'Pending Fees',
        columns: [
          { key: 'admissionNo', label: 'Admission No' },
          { key: 'name', label: 'Student' },
          { key: 'className', label: 'Class' },
          { key: 'sectionName', label: 'Section' },
          { key: 'phone', label: 'Phone' },
          { key: 'invoices', label: 'Open invoices', type: 'number' },
          { key: 'oldestDue', label: 'Oldest due', type: 'date' },
          { key: 'balance', label: 'Balance', type: 'currency' },
        ],
        rows,
        summary: [
          { label: 'Students', value: rows.length },
          { label: 'Total outstanding', value: total.toFixed(2) },
        ],
      };
    },
  }),

  define({
    key: 'admissions',
    name: 'Admissions',
    description: 'Applications in a date range with status, plus a status/class breakdown and enquiry counts.',
    category: 'Admissions',
    permission: 'admissions.view',
    feature: 'admissions',
    params: z.object({ from: isoDate.default(() => new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10)), to: isoDate.default(today), classId: optUuid, status: z.string().optional() }),
    async run(ctx, p) {
      const range = and(gte(admissionApplications.createdAt, new Date(p.from + 'T00:00:00')), lte(admissionApplications.createdAt, new Date(p.to + 'T23:59:59')));
      const rows = await ctx.db
        .select({
          applicationNo: admissionApplications.applicationNo,
          date: sql<string>`to_char(${admissionApplications.createdAt}, 'YYYY-MM-DD')`,
          student: sql<string>`${admissionApplications.student}->>'firstName' || ' ' || coalesce(${admissionApplications.student}->>'lastName','')`,
          guardian: sql<string>`${admissionApplications.guardian}->>'name'`,
          phone: sql<string>`${admissionApplications.guardian}->>'phone'`,
          className: classes.name,
          status: admissionApplications.status,
        })
        .from(admissionApplications)
        .innerJoin(classes, eq(classes.id, admissionApplications.classId))
        .where(and(eq(admissionApplications.schoolId, ctx.schoolId), range, p.classId ? eq(admissionApplications.classId, p.classId) : undefined, p.status ? eq(admissionApplications.status, p.status) : undefined))
        .orderBy(desc(admissionApplications.createdAt));
      const [enq] = await ctx.db
        .select({ n: sql<number>`count(*)::int`, converted: sql<number>`count(*) filter (where ${admissionEnquiries.status} = 'converted')::int` })
        .from(admissionEnquiries)
        .where(and(eq(admissionEnquiries.schoolId, ctx.schoolId), gte(admissionEnquiries.createdAt, new Date(p.from + 'T00:00:00')), lte(admissionEnquiries.createdAt, new Date(p.to + 'T23:59:59'))));
      const by = (k: 'status') => rows.reduce<Record<string, number>>((a, r) => ((a[r[k]] = (a[r[k]] ?? 0) + 1), a), {});
      return {
        title: 'Admissions Report',
        description: `${p.from} to ${p.to}`,
        columns: [
          { key: 'date', label: 'Date', type: 'date' },
          { key: 'applicationNo', label: 'Application' },
          { key: 'student', label: 'Student' },
          { key: 'className', label: 'Class' },
          { key: 'guardian', label: 'Guardian' },
          { key: 'phone', label: 'Phone' },
          { key: 'status', label: 'Status' },
        ],
        rows,
        summary: [
          { label: 'Enquiries', value: enq.n },
          { label: 'Converted enquiries', value: enq.converted },
          { label: 'Applications', value: rows.length },
          ...Object.entries(by('status')).map(([k, v]) => ({ label: k.replace('_', ' '), value: v })),
        ],
      };
    },
  }),

  define({
    key: 'exam-results',
    name: 'Examination results',
    description: 'Class/section results for an exam: total, percentage, grade, pass/fail and rank.',
    category: 'Examinations',
    permission: 'exams.view',
    feature: 'exams',
    params: z.object({ examId: uuid, classId: optUuid, sectionId: optUuid }),
    async run(ctx, p) {
      const res = await examResults(ctx, p.examId, p);
      const subjectsList = [...new Map(res.results.flatMap((r) => r.subjects.map((s) => [s.subjectId, s.subjectName] as const))).entries()];
      return {
        title: `${res.exam.name} — Results`,
        columns: [
          { key: 'rank', label: 'Rank', type: 'number' },
          { key: 'admissionNo', label: 'Admission No' },
          { key: 'name', label: 'Student' },
          { key: 'cls', label: 'Class' },
          ...subjectsList.map(([id, name]) => ({ key: `s_${id}`, label: name, type: 'number' as const })),
          { key: 'total', label: 'Total', type: 'number' },
          { key: 'percentage', label: '%', type: 'percent' },
          { key: 'grade', label: 'Grade' },
          { key: 'result', label: 'Result' },
        ],
        rows: res.results
          .sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999))
          .map((r) => ({
            ...r,
            cls: `${r.className} - ${r.sectionName}`,
            result: r.passed ? 'Pass' : r.complete ? 'Fail' : 'Incomplete',
            ...Object.fromEntries(r.subjects.map((s) => [`s_${s.subjectId}`, s.isAbsent ? 'AB' : s.marks])),
          })),
        summary: [
          { label: 'Students', value: res.summary.students },
          { label: 'Pass rate', value: res.summary.passRate !== null ? `${res.summary.passRate}%` : '—' },
          { label: 'Average', value: res.summary.average !== null ? `${res.summary.average}%` : '—' },
          { label: 'Highest', value: res.summary.highest !== null ? `${res.summary.highest}%` : '—' },
        ],
      };
    },
  }),

  define({
    key: 'class-performance',
    name: 'Class performance',
    description: 'Average percentage and pass rate for each class and section in an exam.',
    category: 'Examinations',
    permission: 'exams.view',
    feature: 'exams',
    params: z.object({ examId: uuid }),
    async run(ctx, p) {
      const { exam, results } = await computeResults(ctx, p.examId);
      const groups = new Map<string, { className: string; sectionName: string; n: number; sum: number; passed: number; top: number }>();
      for (const r of results.filter((x) => x.percentage !== null)) {
        const k = `${r.className}|${r.sectionName}`;
        const g = groups.get(k) ?? { className: r.className, sectionName: r.sectionName, n: 0, sum: 0, passed: 0, top: 0 };
        g.n++;
        g.sum += r.percentage!;
        if (r.passed) g.passed++;
        g.top = Math.max(g.top, r.percentage!);
        groups.set(k, g);
      }
      const rows = [...groups.values()].map((g) => ({ label: `${g.className} - ${g.sectionName}`, ...g, average: Math.round((g.sum / g.n) * 10) / 10, passRate: Math.round((g.passed / g.n) * 1000) / 10 }));
      return {
        title: `${exam.name} — Class Performance`,
        columns: [
          { key: 'label', label: 'Class' },
          { key: 'n', label: 'Students', type: 'number' },
          { key: 'average', label: 'Average %', type: 'percent' },
          { key: 'top', label: 'Top %', type: 'percent' },
          { key: 'passRate', label: 'Pass rate', type: 'percent' },
        ],
        rows,
        chart: { type: 'bar', xKey: 'label', series: [{ key: 'average', label: 'Average %' }, { key: 'passRate', label: 'Pass rate' }] },
      };
    },
  }),

  define({
    key: 'subject-performance',
    name: 'Subject performance',
    description: 'Average, highest, lowest score and pass rate per subject for an exam (optionally one class).',
    category: 'Examinations',
    permission: 'exams.view',
    feature: 'exams',
    params: z.object({ examId: uuid, classId: optUuid, sectionId: optUuid }),
    async run(ctx, p) {
      const res = await examResults(ctx, p.examId, p);
      return {
        title: `${res.exam.name} — Subject Performance`,
        columns: [
          { key: 'subjectName', label: 'Subject' },
          { key: 'appeared', label: 'Appeared', type: 'number' },
          { key: 'average', label: 'Average %', type: 'percent' },
          { key: 'highest', label: 'Highest %', type: 'percent' },
          { key: 'lowest', label: 'Lowest %', type: 'percent' },
          { key: 'passRate', label: 'Pass rate', type: 'percent' },
        ],
        rows: res.subjectStats,
        chart: { type: 'bar', xKey: 'subjectName', series: [{ key: 'average', label: 'Average %' }] },
      };
    },
  }),

  define({
    key: 'exam-compare-years',
    name: 'Results across academic years',
    description: 'Compare a class level\'s exam results (average %, pass rate) across academic years, e.g. "Grade 10 results 2019 vs 2024".',
    category: 'Examinations',
    permission: 'exams.view',
    feature: 'exams',
    params: z.object({ classId: uuid, examName: z.string().optional() }),
    async run(ctx, p) {
      const list = await ctx.db
        .select({ id: exams.id, name: exams.name, year: academicYears.name, start: academicYears.startDate })
        .from(exams)
        .innerJoin(academicYears, eq(academicYears.id, exams.academicYearId))
        .where(and(eq(exams.schoolId, ctx.schoolId), eq(exams.status, 'published'), p.examName ? sql`${exams.name} ilike ${'%' + p.examName + '%'}` : undefined))
        .orderBy(asc(academicYears.startDate), asc(exams.startDate));
      const rows = [];
      for (const e of list) {
        const { results } = await computeResults(ctx, e.id, { classId: p.classId });
        const done = results.filter((r) => r.percentage !== null);
        if (!done.length) continue;
        rows.push({
          academicYear: e.year,
          exam: e.name,
          students: done.length,
          average: Math.round((done.reduce((a, r) => a + r.percentage!, 0) / done.length) * 10) / 10,
          passRate: Math.round((done.filter((r) => r.passed).length / done.length) * 1000) / 10,
          highest: Math.max(...done.map((r) => r.percentage!)),
          label: `${e.year} · ${e.name}`,
        });
      }
      return {
        title: 'Examination Results Across Years',
        columns: [
          { key: 'academicYear', label: 'Year' },
          { key: 'exam', label: 'Exam' },
          { key: 'students', label: 'Students', type: 'number' },
          { key: 'average', label: 'Average %', type: 'percent' },
          { key: 'highest', label: 'Highest %', type: 'percent' },
          { key: 'passRate', label: 'Pass rate', type: 'percent' },
        ],
        rows,
        chart: { type: 'line', xKey: 'label', series: [{ key: 'average', label: 'Average %' }, { key: 'passRate', label: 'Pass rate' }] },
      };
    },
  }),

  define({
    key: 'student-performance-history',
    name: 'Student performance history',
    description: 'Every published exam result for one student across all academic years.',
    category: 'Examinations',
    permission: 'exams.view',
    feature: 'exams',
    params: z.object({ studentId: uuid }),
    async run(ctx, p) {
      const hist = await studentHistory(ctx, p.studentId);
      const [s] = await ctx.db.select().from(students).where(and(eq(students.id, p.studentId), eq(students.schoolId, ctx.schoolId)));
      return {
        title: `Performance History — ${s ? `${s.firstName} ${s.lastName}` : ''}`,
        columns: [
          { key: 'academicYear', label: 'Year' },
          { key: 'className', label: 'Class' },
          { key: 'examName', label: 'Exam' },
          { key: 'percentage', label: '%', type: 'percent' },
          { key: 'grade', label: 'Grade' },
          { key: 'rank', label: 'Rank', type: 'number' },
          { key: 'result', label: 'Result' },
        ],
        rows: hist.map((h) => ({ ...h, label: `${h.academicYear} ${h.examName}`, result: h.passed ? 'Pass' : 'Fail' })),
        chart: { type: 'line', xKey: 'label', series: [{ key: 'percentage', label: 'Percentage' }] },
      };
    },
  }),

  define({
    key: 'teachers',
    name: 'Teacher workload & attendance',
    description: 'Each teacher\'s class-teacher sections, subject allocations, weekly periods and attendance for a date range.',
    category: 'Staff',
    permission: 'staff.view',
    params: z.object({ from: isoDate.default(monthAgo), to: isoDate.default(today) }),
    async run(ctx, p) {
      const yearId = await resolveYearId(ctx, null);
      const rows = await ctx.db
        .select({
          id: users.id,
          name: users.fullName,
          email: users.email,
          classTeacherOf: sql<string>`(select string_agg(c.name || '-' || s.name, ', ') from sections s join classes c on c.id = s.class_id where s.class_teacher_id = ${users.id} and s.academic_year_id = ${yearId})`,
          subjects: sql<number>`(select count(*)::int from ${sectionSubjects} ss join sections s on s.id = ss.section_id where ss.teacher_id = ${users.id} and s.academic_year_id = ${yearId})`,
          periodsPerWeek: sql<number>`(select count(*)::int from ${timetableEntries} t join sections s on s.id = t.section_id where t.teacher_id = ${users.id} and s.academic_year_id = ${yearId})`,
          daysMarked: sql<number>`(select count(*)::int from ${staffAttendance} a where a.user_id = ${users.id} and a.date between ${p.from} and ${p.to})`,
          daysPresent: sql<number>`(select count(*)::int from ${staffAttendance} a where a.user_id = ${users.id} and a.date between ${p.from} and ${p.to} and a.status in ('present','late'))`,
        })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(and(eq(users.schoolId, ctx.schoolId), eq(users.isActive, true), eq(roles.key, 'teacher')))
        .orderBy(asc(users.fullName));
      return {
        title: 'Teacher Report',
        description: `Attendance ${p.from} to ${p.to}`,
        columns: [
          { key: 'name', label: 'Teacher' },
          { key: 'classTeacherOf', label: 'Class teacher of' },
          { key: 'subjects', label: 'Subject allocations', type: 'number' },
          { key: 'periodsPerWeek', label: 'Periods / week', type: 'number' },
          { key: 'daysMarked', label: 'Days marked', type: 'number' },
          { key: 'attendance', label: 'Attendance %', type: 'percent' },
        ],
        rows: rows.map((r) => ({ ...r, attendance: r.daysMarked ? Math.round((r.daysPresent / r.daysMarked) * 1000) / 10 : null })),
      };
    },
  }),

  define({
    key: 'academic-year-comparison',
    name: 'Academic year comparison',
    description: 'Key figures per academic year: enrolment, attendance, average exam score and fee collection.',
    category: 'Academic',
    permission: 'reports.view',
    params: z.object({}),
    async run(ctx) {
      requirePermission(ctx, 'students.view');
      const years = await ctx.db.select().from(academicYears).where(eq(academicYears.schoolId, ctx.schoolId)).orderBy(asc(academicYears.startDate));
      const rows = [];
      for (const y of years) {
        const [[en], [att], [fee]] = await Promise.all([
          ctx.db.select({ n: sql<number>`count(*)::int` }).from(enrollments).where(eq(enrollments.academicYearId, y.id)),
          ctx.db
            .select({ pct: sql<number | null>`round(100.0 * sum(${ATTENDANCE_SCORE}) / nullif(count(*),0), 1)::float` })
            .from(attendanceRecords)
            .innerJoin(sections, eq(sections.id, attendanceRecords.sectionId))
            .where(eq(sections.academicYearId, y.id)),
          ctx.db
            .select({ billed: sql<number>`coalesce(sum(${feeInvoices.amount} - ${feeInvoices.discount} - ${feeInvoices.scholarship}),0)::float`, paid: sql<number>`coalesce(sum(${feeInvoices.paid}),0)::float` })
            .from(feeInvoices)
            .where(and(eq(feeInvoices.academicYearId, y.id), sql`${feeInvoices.status} <> 'cancelled'`)),
        ]);
        const yearExams = await ctx.db.select({ id: exams.id }).from(exams).where(and(eq(exams.academicYearId, y.id), eq(exams.status, 'published')));
        let sum = 0;
        let n = 0;
        let passed = 0;
        for (const e of yearExams) {
          const { results } = await computeResults(ctx, e.id);
          for (const r of results) if (r.percentage !== null) (sum += r.percentage, n++, r.passed && passed++);
        }
        rows.push({
          academicYear: y.name,
          students: en.n,
          attendance: att.pct,
          examAverage: n ? Math.round((sum / n) * 10) / 10 : null,
          passRate: n ? Math.round((passed / n) * 1000) / 10 : null,
          feesBilled: fee.billed,
          feesCollected: fee.paid,
        });
      }
      return {
        title: 'Academic Year Comparison',
        columns: [
          { key: 'academicYear', label: 'Year' },
          { key: 'students', label: 'Students', type: 'number' },
          { key: 'attendance', label: 'Attendance %', type: 'percent' },
          { key: 'examAverage', label: 'Exam average %', type: 'percent' },
          { key: 'passRate', label: 'Pass rate', type: 'percent' },
          { key: 'feesBilled', label: 'Fees billed', type: 'currency' },
          { key: 'feesCollected', label: 'Fees collected', type: 'currency' },
        ],
        rows,
        chart: { type: 'bar', xKey: 'academicYear', series: [{ key: 'attendance', label: 'Attendance %' }, { key: 'examAverage', label: 'Exam average %' }] },
      };
    },
  }),
];

export function availableReports(ctx: Ctx) {
  return reports.filter((r) => ctx.permissions.has(r.permission) && ctx.permissions.has('reports.view') && (!r.feature || ctx.features.has(r.feature)));
}

/** The single entry point for running a report — used by HTTP and (later) MCP. */
export async function runReport(ctx: Ctx, key: string, rawParams: unknown): Promise<ReportResult> {
  const def = reports.find((r) => r.key === key);
  if (!def) throw badRequest(`Unknown report "${key}"`);
  requirePermission(ctx, 'reports.view', def.permission);
  if (def.feature) requireFeature(ctx, def.feature);
  const params = def.params.parse(rawParams ?? {});
  return def.run(ctx, params);
}
