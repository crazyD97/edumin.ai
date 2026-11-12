/**
 * Examinations & results.
 *
 * An exam has papers (exam × class × subject). Marks are stored per paper per
 * student; results (totals, percentage, grade, pass/fail, rank) are always
 * computed from marks so they stay consistent with any correction and remain
 * reproducible for historical years.
 */
import { z } from 'zod';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { EXAM_STATUSES } from '@edumin/shared';
import {
  academicYears,
  attendanceRecords,
  classes,
  enrollments,
  examPapers,
  exams,
  gradingScales,
  marks,
  sectionSubjects,
  sections,
  students,
  subjects,
  type GradeBand,
} from '../../db/schema';
import { assertSectionAccess, assertStudentAccess, can, ownStudentIds, requirePermission, scopedSectionIds, teacherSectionIds, type Ctx } from '../../core/context';
import { badRequest, forbidden, must } from '../../core/errors';
import { audit } from '../../core/audit';
import { audience, notifyFamilies, notifyUsers } from '../../core/notify';
import { resolveYearId } from '../academics/routes';
import { createDoc, footer, infoGrid, letterhead, loadSchoolHeader, table, toBuffer, type Doc, type SchoolHeader } from '../../core/pdf';
import { ATTENDANCE_SCORE } from '../attendance/service';

// ── Grading ──

export const gradingInput = z.object({
  name: z.string().trim().min(2).max(100),
  passPercent: z.coerce.number().min(0).max(100),
  isDefault: z.boolean().default(false),
  bands: z
    .array(z.object({ grade: z.string().trim().min(1).max(5), min: z.coerce.number().min(0).max(100), point: z.coerce.number().optional(), remark: z.string().trim().max(50).optional() }))
    .min(1),
});

export function gradeFor(pct: number | null, bands: GradeBand[]) {
  if (pct === null) return null;
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  return sorted.find((b) => pct >= b.min) ?? sorted[sorted.length - 1];
}

async function scaleFor(ctx: Ctx, scaleId: string | null) {
  const rows = await ctx.db
    .select()
    .from(gradingScales)
    .where(and(eq(gradingScales.schoolId, ctx.schoolId), scaleId ? eq(gradingScales.id, scaleId) : eq(gradingScales.isDefault, true)))
    .limit(1);
  return rows[0] ?? { passPercent: 33, bands: [{ grade: 'P', min: 33 }, { grade: 'F', min: 0 }] as GradeBand[] };
}

// ── Exams ──

export const examInput = z.object({
  academicYearId: z.uuid().optional(),
  name: z.string().trim().min(2).max(150),
  term: z.string().trim().max(50).nullish(),
  gradingScaleId: z.uuid().nullish(),
  startDate: z.iso.date().nullish(),
  endDate: z.iso.date().nullish(),
  description: z.string().trim().nullish(),
  status: z.enum(EXAM_STATUSES).optional(),
});

export async function getExam(ctx: Ctx, id: string) {
  const [e] = await ctx.db.select().from(exams).where(and(eq(exams.id, id), eq(exams.schoolId, ctx.schoolId)));
  const exam = must(e, 'Exam');
  // Students and parents only see published results; drafts are hidden entirely.
  if (ctx.scope === 'own' && exam.status === 'draft') throw must(null, 'Exam');
  return exam;
}

export async function listExams(ctx: Ctx, academicYearId?: string) {
  requirePermission(ctx, 'exams.view');
  const yearId = await resolveYearId(ctx, academicYearId);
  const rows = await ctx.db
    .select({
      exam: exams,
      scaleName: gradingScales.name,
      paperCount: sql<number>`(select count(*)::int from ${examPapers} where ${examPapers.examId} = ${exams.id})`,
      classCount: sql<number>`(select count(distinct ${examPapers.classId})::int from ${examPapers} where ${examPapers.examId} = ${exams.id})`,
    })
    .from(exams)
    .leftJoin(gradingScales, eq(gradingScales.id, exams.gradingScaleId))
    .where(and(eq(exams.schoolId, ctx.schoolId), eq(exams.academicYearId, yearId), ctx.scope === 'own' ? sql`${exams.status} <> 'draft'` : undefined))
    .orderBy(desc(exams.startDate));
  return rows.map((r) => ({ ...r.exam, scaleName: r.scaleName, paperCount: r.paperCount, classCount: r.classCount }));
}

export async function createExam(ctx: Ctx, v: z.infer<typeof examInput>) {
  requirePermission(ctx, 'exams.create');
  if (ctx.scope !== 'school') throw forbidden('Only administrators can create examinations');
  const academicYearId = await resolveYearId(ctx, v.academicYearId);
  const scale = await scaleFor(ctx, v.gradingScaleId ?? null);
  const [row] = await ctx.db
    .insert(exams)
    .values({ ...v, academicYearId, schoolId: ctx.schoolId, gradingScaleId: 'id' in scale ? scale.id : null, status: v.status ?? 'draft' })
    .returning();
  await audit(ctx, 'create', 'exam', row.id);
  return row;
}

export async function updateExam(ctx: Ctx, id: string, v: z.infer<typeof examInput>) {
  requirePermission(ctx, 'exams.edit');
  if (ctx.scope !== 'school') throw forbidden('Only administrators can edit examinations');
  const exam = await getExam(ctx, id);
  if (exam.status === 'published' && v.status && v.status !== 'published') requirePermission(ctx, 'exams.approve');
  const { academicYearId: _y, ...rest } = v;
  const [row] = await ctx.db.update(exams).set(rest).where(eq(exams.id, id)).returning();
  const announce = v.status === 'scheduled' && exam.status === 'draft';
  if (announce) await announceExam(ctx, row);
  return row;
}

async function announceExam(ctx: Ctx, exam: typeof exams.$inferSelect) {
  const classIds = (await ctx.db.selectDistinct({ id: examPapers.classId }).from(examPapers).where(eq(examPapers.examId, exam.id))).map((r) => r.id);
  const studentIds = await audience.studentsInClasses(ctx.db, ctx.schoolId, classIds, exam.academicYearId);
  await notifyFamilies(ctx.db, ctx.schoolId, studentIds, {
    type: 'exam_scheduled',
    title: `${exam.name} has been scheduled`,
    body: exam.startDate ? `Starts ${exam.startDate}. Check the exam timetable for details.` : 'Check the exam timetable for details.',
    link: `/exams/${exam.id}`,
    event: 'exam_scheduled',
    vars: { exam: exam.name, date: exam.startDate ? new Date(exam.startDate + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'soon' },
    createdBy: ctx.userId,
  });
}

// ── Papers (schedule) ──

export async function listPapers(ctx: Ctx, examId: string, classId?: string) {
  requirePermission(ctx, 'exams.view');
  await getExam(ctx, examId);
  let classFilter: string[] | null = classId ? [classId] : null;
  if (ctx.scope !== 'school') {
    const secs = await scopedSectionIds(ctx);
    const cls = secs?.length ? (await ctx.db.selectDistinct({ id: sections.classId }).from(sections).where(inArray(sections.id, secs))).map((r) => r.id) : [];
    classFilter = classFilter ? classFilter.filter((c) => cls.includes(c)) : cls;
  }
  if (classFilter && !classFilter.length) return [];
  return ctx.db
    .select({
      id: examPapers.id,
      classId: classes.id,
      className: classes.name,
      subjectId: subjects.id,
      subjectName: subjects.name,
      date: examPapers.date,
      startTime: examPapers.startTime,
      endTime: examPapers.endTime,
      maxMarks: examPapers.maxMarks,
      passMarks: examPapers.passMarks,
      room: examPapers.room,
      marksEntered: sql<number>`(select count(*)::int from ${marks} where ${marks.paperId} = ${examPapers.id} and (${marks.marksObtained} is not null or ${marks.isAbsent}))`,
    })
    .from(examPapers)
    .innerJoin(classes, eq(classes.id, examPapers.classId))
    .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
    .where(and(eq(examPapers.examId, examId), classFilter ? inArray(examPapers.classId, classFilter) : undefined))
    .orderBy(asc(classes.level), asc(examPapers.date), asc(subjects.name));
}

export const papersInput = z.object({
  classId: z.uuid(),
  items: z
    .array(
      z.object({
        subjectId: z.uuid(),
        date: z.iso.date().nullish().or(z.literal('').transform(() => null)),
        startTime: z.string().regex(/^\d{2}:\d{2}/).nullish().or(z.literal('').transform(() => null)),
        endTime: z.string().regex(/^\d{2}:\d{2}/).nullish().or(z.literal('').transform(() => null)),
        maxMarks: z.coerce.number().positive(),
        passMarks: z.coerce.number().min(0),
        room: z.string().trim().max(50).nullish(),
      }),
    )
    .min(1),
});

/** Upserts a class's paper list for an exam. Papers with marks are never dropped. */
export async function savePapers(ctx: Ctx, examId: string, v: z.infer<typeof papersInput>) {
  requirePermission(ctx, 'exams.edit');
  if (ctx.scope !== 'school') throw forbidden();
  const exam = await getExam(ctx, examId);
  if (exam.status === 'published') throw badRequest('Results are published; unpublish the exam to change its papers');
  must((await ctx.db.select({ id: classes.id }).from(classes).where(and(eq(classes.id, v.classId), eq(classes.schoolId, ctx.schoolId))))[0], 'Class');
  for (const it of v.items) if (it.passMarks > it.maxMarks) throw badRequest('Pass marks cannot exceed maximum marks');
  await ctx.db.transaction(async (tx) => {
    for (const it of v.items) {
      await tx
        .insert(examPapers)
        .values({ ...it, schoolId: ctx.schoolId, examId, classId: v.classId })
        .onConflictDoUpdate({
          target: [examPapers.examId, examPapers.classId, examPapers.subjectId],
          set: { date: it.date ?? null, startTime: it.startTime ?? null, endTime: it.endTime ?? null, maxMarks: it.maxMarks, passMarks: it.passMarks, room: it.room ?? null },
        });
    }
    const keep = v.items.map((i) => i.subjectId);
    await tx
      .delete(examPapers)
      .where(
        and(
          eq(examPapers.examId, examId),
          eq(examPapers.classId, v.classId),
          notInArray(examPapers.subjectId, keep),
          sql`not exists (select 1 from marks m where m.paper_id = ${examPapers.id})`,
        ),
      );
  });
  return listPapers(ctx, examId, v.classId);
}

// ── Marks entry ──

async function getPaper(ctx: Ctx, paperId: string) {
  const [p] = await ctx.db
    .select({ paper: examPapers, exam: exams, subjectName: subjects.name, className: classes.name })
    .from(examPapers)
    .innerJoin(exams, eq(exams.id, examPapers.examId))
    .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
    .innerJoin(classes, eq(classes.id, examPapers.classId))
    .where(and(eq(examPapers.id, paperId), eq(examPapers.schoolId, ctx.schoolId)));
  return must(p, 'Exam paper');
}

/** Teachers may enter marks for subjects they teach in that section, or as class teacher. */
async function assertCanEnterMarks(ctx: Ctx, paper: typeof examPapers.$inferSelect, sectionId: string) {
  if (ctx.scope === 'school') return;
  if (ctx.scope !== 'assigned') throw forbidden();
  const [sec] = await ctx.db.select().from(sections).where(and(eq(sections.id, sectionId), eq(sections.schoolId, ctx.schoolId)));
  must(sec, 'Section');
  if (sec.classTeacherId === ctx.userId) return;
  const [ss] = await ctx.db
    .select()
    .from(sectionSubjects)
    .where(and(eq(sectionSubjects.sectionId, sectionId), eq(sectionSubjects.subjectId, paper.subjectId), eq(sectionSubjects.teacherId, ctx.userId)));
  if (!ss) throw forbidden('You do not teach this subject in this section');
}

export async function getMarksSheet(ctx: Ctx, paperId: string, sectionId: string) {
  requirePermission(ctx, 'exams.view');
  await assertSectionAccess(ctx, sectionId);
  const p = await getPaper(ctx, paperId);
  const [sec] = await ctx.db.select().from(sections).where(and(eq(sections.id, sectionId), eq(sections.schoolId, ctx.schoolId)));
  if (!sec || sec.classId !== p.paper.classId || sec.academicYearId !== p.exam.academicYearId) throw badRequest('Section does not belong to this paper');
  const rows = await ctx.db
    .select({
      studentId: students.id,
      admissionNo: students.admissionNo,
      name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
      rollNo: enrollments.rollNo,
      marksObtained: marks.marksObtained,
      isAbsent: marks.isAbsent,
      remarks: marks.remarks,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .leftJoin(marks, and(eq(marks.studentId, students.id), eq(marks.paperId, paperId)))
    .where(eq(enrollments.sectionId, sectionId))
    .orderBy(asc(enrollments.rollNo), asc(students.firstName));
  let canEdit = can(ctx, 'exams.edit') && p.exam.status !== 'published';
  if (canEdit) canEdit = await assertCanEnterMarks(ctx, p.paper, sectionId).then(() => true, () => false);
  return { paper: { ...p.paper, subjectName: p.subjectName, className: p.className }, exam: p.exam, canEdit, students: rows };
}

export const marksInput = z.object({
  sectionId: z.uuid(),
  entries: z.array(
    z.object({
      studentId: z.uuid(),
      marksObtained: z.coerce.number().min(0).nullish(),
      isAbsent: z.boolean().default(false),
      remarks: z.string().trim().max(255).nullish(),
    }),
  ),
});

export async function saveMarks(ctx: Ctx, paperId: string, v: z.infer<typeof marksInput>) {
  requirePermission(ctx, 'exams.edit');
  const p = await getPaper(ctx, paperId);
  if (p.exam.status === 'published') throw badRequest('Results are published and locked. Ask an administrator to unpublish them first.');
  await assertCanEnterMarks(ctx, p.paper, v.sectionId);
  const enrolled = new Set(
    (await ctx.db.select({ id: enrollments.studentId }).from(enrollments).where(eq(enrollments.sectionId, v.sectionId))).map((r) => r.id),
  );
  for (const e of v.entries) {
    if (!enrolled.has(e.studentId)) throw badRequest('A student is not enrolled in this section');
    if (e.marksObtained != null && e.marksObtained > p.paper.maxMarks) throw badRequest(`Marks cannot exceed ${p.paper.maxMarks}`);
  }
  if (!v.entries.length) return { saved: 0 };
  await ctx.db
    .insert(marks)
    .values(
      v.entries.map((e) => ({
        schoolId: ctx.schoolId,
        paperId,
        studentId: e.studentId,
        marksObtained: e.isAbsent ? null : (e.marksObtained ?? null),
        isAbsent: e.isAbsent,
        remarks: e.remarks ?? null,
        enteredBy: ctx.userId,
      })),
    )
    .onConflictDoUpdate({
      target: [marks.paperId, marks.studentId],
      set: { marksObtained: sql`excluded.marks_obtained`, isAbsent: sql`excluded.is_absent`, remarks: sql`excluded.remarks`, enteredBy: ctx.userId },
    });
  if (p.exam.status === 'scheduled') await ctx.db.update(exams).set({ status: 'marks_entry' }).where(eq(exams.id, p.exam.id));
  return { saved: v.entries.length };
}

// ── Results ──

export interface SubjectResult {
  paperId: string;
  subjectId: string;
  subjectName: string;
  maxMarks: number;
  passMarks: number;
  marks: number | null;
  isAbsent: boolean;
  passed: boolean;
  grade: string | null;
}

export interface StudentResult {
  studentId: string;
  admissionNo: string;
  name: string;
  rollNo: number | null;
  sectionId: string;
  sectionName: string;
  className: string;
  subjects: SubjectResult[];
  total: number;
  maxTotal: number;
  percentage: number | null;
  grade: string | null;
  gradeRemark: string | null;
  passed: boolean;
  complete: boolean;
  rank: number | null;
  sectionRank: number | null;
}

/**
 * Computes results for an exam. Ranks are competition-style (1,2,2,4) by
 * percentage within the class and within the section; failed students are
 * ranked after all passed students.
 */
export async function computeResults(ctx: Ctx, examId: string, f: { classId?: string | null; sectionId?: string | null; studentIds?: string[] } = {}) {
  const exam = await getExam(ctx, examId);
  const scale = await scaleFor(ctx, exam.gradingScaleId);
  const papers = await ctx.db
    .select({ paper: examPapers, subjectName: subjects.name })
    .from(examPapers)
    .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
    .where(and(eq(examPapers.examId, examId), f.classId ? eq(examPapers.classId, f.classId) : undefined))
    .orderBy(asc(subjects.name));
  if (!papers.length) return { exam, scale, results: [] as StudentResult[], papers: [], classSizes: {} as Record<string, number> };

  const classIds = [...new Set(papers.map((p) => p.paper.classId))];
  const roster = await ctx.db
    .select({
      studentId: students.id,
      admissionNo: students.admissionNo,
      name: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
      rollNo: enrollments.rollNo,
      sectionId: sections.id,
      sectionName: sections.name,
      classId: classes.id,
      className: classes.name,
    })
    .from(enrollments)
    .innerJoin(sections, eq(sections.id, enrollments.sectionId))
    .innerJoin(classes, eq(classes.id, sections.classId))
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(and(eq(enrollments.academicYearId, exam.academicYearId), inArray(sections.classId, classIds), f.sectionId ? eq(sections.id, f.sectionId) : undefined))
    .orderBy(asc(classes.level), asc(sections.name), asc(enrollments.rollNo));

  const markRows = await ctx.db
    .select()
    .from(marks)
    .where(inArray(marks.paperId, papers.map((p) => p.paper.id)));
  const markMap = new Map(markRows.map((m) => [`${m.paperId}|${m.studentId}`, m]));

  const results: StudentResult[] = roster.map((s) => {
    const own = papers.filter((p) => p.paper.classId === s.classId);
    const subs: SubjectResult[] = own.map((p) => {
      const m = markMap.get(`${p.paper.id}|${s.studentId}`);
      const val = m?.marksObtained ?? null;
      const pct = val === null ? null : (val / p.paper.maxMarks) * 100;
      return {
        paperId: p.paper.id,
        subjectId: p.paper.subjectId,
        subjectName: p.subjectName,
        maxMarks: p.paper.maxMarks,
        passMarks: p.paper.passMarks,
        marks: val,
        isAbsent: m?.isAbsent ?? false,
        passed: val !== null && val >= p.paper.passMarks,
        grade: gradeFor(pct, scale.bands)?.grade ?? null,
      };
    });
    const entered = subs.filter((x) => x.marks !== null || x.isAbsent);
    const total = subs.reduce((a, x) => a + (x.marks ?? 0), 0);
    const maxTotal = subs.reduce((a, x) => a + x.maxMarks, 0);
    const complete = entered.length === subs.length && subs.length > 0;
    const percentage = entered.length ? Math.round((total / maxTotal) * 10000) / 100 : null;
    const g = gradeFor(percentage, scale.bands);
    const passed = complete && subs.every((x) => x.passed) && (percentage ?? 0) >= scale.passPercent;
    return {
      studentId: s.studentId,
      admissionNo: s.admissionNo,
      name: s.name,
      rollNo: s.rollNo,
      sectionId: s.sectionId,
      sectionName: s.sectionName,
      className: s.className,
      classId: s.classId,
      subjects: subs,
      total: Math.round(total * 100) / 100,
      maxTotal,
      percentage,
      grade: g?.grade ?? null,
      gradeRemark: complete && !(subs.every((x) => x.passed) && (percentage ?? 0) >= scale.passPercent) ? 'Did not meet the pass criteria' : (g?.remark ?? null),
      passed,
      complete,
      rank: null,
      sectionRank: null,
    } as StudentResult & { classId: string };
  });

  const rankBy = (group: (r: StudentResult) => string, key: 'rank' | 'sectionRank') => {
    const groups = new Map<string, StudentResult[]>();
    for (const r of results) if (r.percentage !== null) groups.set(group(r), [...(groups.get(group(r)) ?? []), r]);
    for (const list of groups.values()) {
      list.sort((a, b) => Number(b.passed) - Number(a.passed) || (b.percentage ?? 0) - (a.percentage ?? 0));
      list.forEach((r, i) => {
        const prev = list[i - 1];
        r[key] = prev && prev.passed === r.passed && prev.percentage === r.percentage ? prev[key] : i + 1;
      });
    }
  };
  rankBy((r) => (r as any).classId, 'rank');
  rankBy((r) => r.sectionId, 'sectionRank');

  // Class sizes are computed before scope filtering so ranks read "n / class size".
  const classSizes: Record<string, number> = {};
  for (const r of results) if (r.percentage !== null) classSizes[r.className] = (classSizes[r.className] ?? 0) + 1;

  let visible = results;
  const scopedSecs = await scopedSectionIds(ctx);
  if (ctx.scope === 'own') {
    const own = await ownStudentIds(ctx);
    visible = results.filter((r) => own.includes(r.studentId));
  } else if (scopedSecs) {
    visible = results.filter((r) => scopedSecs.includes(r.sectionId));
  }
  if (f.studentIds) visible = visible.filter((r) => f.studentIds!.includes(r.studentId));
  return { exam, scale, results: visible, papers, classSizes };
}

export async function examResults(ctx: Ctx, examId: string, f: { classId?: string | null; sectionId?: string | null }) {
  requirePermission(ctx, 'exams.view');
  const exam = await getExam(ctx, examId);
  if (ctx.scope === 'own' && exam.status !== 'published') throw forbidden('Results have not been published yet');
  const { results, scale, papers } = await computeResults(ctx, examId, f);
  // Subject analysis
  const bySubject = new Map<string, { subjectName: string; scores: number[]; max: number; passed: number; appeared: number }>();
  for (const r of results)
    for (const s of r.subjects) {
      const e = bySubject.get(s.subjectId) ?? { subjectName: s.subjectName, scores: [], max: s.maxMarks, passed: 0, appeared: 0 };
      if (s.marks !== null) {
        e.scores.push((s.marks / s.maxMarks) * 100);
        e.appeared++;
        if (s.passed) e.passed++;
      }
      bySubject.set(s.subjectId, e);
    }
  const subjectStats = [...bySubject.entries()].map(([subjectId, e]) => ({
    subjectId,
    subjectName: e.subjectName,
    appeared: e.appeared,
    average: e.scores.length ? Math.round((e.scores.reduce((a, b) => a + b, 0) / e.scores.length) * 10) / 10 : null,
    highest: e.scores.length ? Math.round(Math.max(...e.scores) * 10) / 10 : null,
    lowest: e.scores.length ? Math.round(Math.min(...e.scores) * 10) / 10 : null,
    passRate: e.appeared ? Math.round((e.passed / e.appeared) * 1000) / 10 : null,
  }));
  const withPct = results.filter((r) => r.percentage !== null);
  const gradeDist: Record<string, number> = {};
  for (const r of withPct) if (r.grade) gradeDist[r.grade] = (gradeDist[r.grade] ?? 0) + 1;
  return {
    exam,
    scale,
    paperCount: papers.length,
    results,
    subjectStats,
    summary: {
      students: results.length,
      appeared: withPct.length,
      passed: results.filter((r) => r.passed).length,
      passRate: withPct.length ? Math.round((results.filter((r) => r.passed).length / withPct.length) * 1000) / 10 : null,
      average: withPct.length ? Math.round((withPct.reduce((a, r) => a + (r.percentage ?? 0), 0) / withPct.length) * 10) / 10 : null,
      highest: withPct.length ? Math.max(...withPct.map((r) => r.percentage ?? 0)) : null,
      gradeDistribution: Object.entries(gradeDist).map(([grade, count]) => ({ grade, count })),
    },
  };
}

export async function publishExam(ctx: Ctx, examId: string, publish: boolean) {
  requirePermission(ctx, 'exams.approve');
  if (ctx.scope !== 'school') throw forbidden();
  const exam = await getExam(ctx, examId);
  if (publish) {
    const { results } = await computeResults(ctx, examId);
    const incomplete = results.filter((r) => !r.complete).length;
    if (!results.length) throw badRequest('No results to publish');
    const [row] = await ctx.db.update(exams).set({ status: 'published', approvedBy: ctx.userId, approvedAt: new Date() }).where(eq(exams.id, examId)).returning();
    const byStudent = new Map(results.map((r) => [r.studentId, r]));
    await notifyFamilies(ctx.db, ctx.schoolId, results.map((r) => r.studentId), {
      type: 'exam_results',
      title: `Results published: ${exam.name}`,
      body: 'View the result and download the report card.',
      link: `/exams/${examId}`,
      event: 'exam_results',
      vars: (s) => {
        const r = byStudent.get(s.id)!;
        return { exam: exam.name, result: r.percentage === null ? 'Absent' : `${r.percentage}%, grade ${r.grade ?? '-'}${r.rank ? `, rank ${r.rank}` : ''}` };
      },
      attachment: (studentId) => ({ kind: 'report_card', ref: { examId, studentId }, filename: `report-card-${byStudent.get(studentId)?.admissionNo ?? studentId}.pdf` }),
      createdBy: ctx.userId,
    });
    await audit(ctx, 'publish', 'exam', examId, { incomplete });
    return { ...row, incomplete };
  }
  const [row] = await ctx.db.update(exams).set({ status: 'marks_entry', approvedBy: null, approvedAt: null }).where(eq(exams.id, examId)).returning();
  await audit(ctx, 'unpublish', 'exam', examId);
  return { ...row, incomplete: 0 };
}

/** Every published result for a student across all years — the academic record. */
export async function studentHistory(ctx: Ctx, studentId: string) {
  requirePermission(ctx, 'exams.view');
  await assertStudentAccess(ctx, studentId);
  const examRows = await ctx.db
    .selectDistinct({ id: exams.id, name: exams.name, startDate: exams.startDate, year: academicYears.name, yearStart: academicYears.startDate, status: exams.status })
    .from(marks)
    .innerJoin(examPapers, eq(examPapers.id, marks.paperId))
    .innerJoin(exams, eq(exams.id, examPapers.examId))
    .innerJoin(academicYears, eq(academicYears.id, exams.academicYearId))
    .where(and(eq(marks.studentId, studentId), ctx.scope === 'own' ? eq(exams.status, 'published') : undefined))
    .orderBy(asc(academicYears.startDate), asc(exams.startDate));
  const out = [];
  for (const e of examRows) {
    const { results } = await computeResults(ctx, e.id, { studentIds: [studentId] });
    const r = results[0];
    if (r) out.push({ examId: e.id, examName: e.name, academicYear: e.year, status: e.status, className: r.className, percentage: r.percentage, grade: r.grade, rank: r.rank, passed: r.passed, subjects: r.subjects });
  }
  return out;
}

// ── Report cards ──

async function attendancePct(ctx: Ctx, studentId: string, yearId: string) {
  const [y] = await ctx.db.select().from(academicYears).where(eq(academicYears.id, yearId));
  const [r] = await ctx.db
    .select({ pct: sql<number | null>`round(100.0 * sum(${ATTENDANCE_SCORE}) / nullif(count(*),0), 1)::float`, days: sql<number>`count(*)::int` })
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.studentId, studentId), sql`${attendanceRecords.date} between ${y.startDate} and ${y.endDate}`));
  return r;
}

function drawReportCard(doc: Doc, h: SchoolHeader, exam: typeof exams.$inferSelect, yearName: string, r: StudentResult, att: { pct: number | null; days: number }, classSize: number) {
  let y = letterhead(doc, h, 'Report Card', h.branding.reportCardHeader ?? `${exam.name} · Academic Year ${yearName}`);
  y = infoGrid(doc, y, [
    ['Student', r.name],
    ['Admission No', r.admissionNo],
    ['Class', `${r.className} - ${r.sectionName}`],
    ['Roll No', r.rollNo],
    ['Examination', exam.name],
    ['Attendance', att.pct !== null ? `${att.pct}% (${att.days} days)` : '—'],
  ]);
  y = table(
    doc,
    y + 4,
    [
      { label: 'Subject', width: 0.34 },
      { label: 'Max', width: 0.12, align: 'right' },
      { label: 'Pass', width: 0.12, align: 'right' },
      { label: 'Obtained', width: 0.16, align: 'right' },
      { label: 'Grade', width: 0.12, align: 'center' },
      { label: 'Result', width: 0.14, align: 'center' },
    ],
    [
      ...r.subjects.map((s) => [s.subjectName, s.maxMarks, s.passMarks, s.isAbsent ? 'AB' : s.marks ?? '—', s.grade ?? '—', s.isAbsent ? 'Absent' : s.marks === null ? '—' : s.passed ? 'Pass' : 'Fail']),
      ['Total', r.maxTotal, '', r.total, r.grade ?? '—', r.passed ? 'PASS' : r.complete ? 'FAIL' : 'INCOMPLETE'],
    ],
    h.branding.primaryColor,
    { boldLast: true },
  );
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const boxW = width / 4;
  const stats: [string, string][] = [
    ['Percentage', r.percentage !== null ? `${r.percentage}%` : '—'],
    ['Grade', r.grade ?? '—'],
    ['Class Rank', r.rank ? `${r.rank} / ${classSize}` : '—'],
    ['Result', r.passed ? 'PASS' : r.complete ? 'FAIL' : 'INCOMPLETE'],
  ];
  stats.forEach(([k, v], i) => {
    const x = left + i * boxW;
    doc.roundedRect(x + 3, y, boxW - 6, 46, 4).fillAndStroke('#f8fafc', '#e2e8f0');
    doc.fillColor('#64748b').font('Helvetica').fontSize(8).text(k, x + 3, y + 8, { width: boxW - 6, align: 'center' });
    doc.fillColor(h.branding.primaryColor).font('Helvetica-Bold').fontSize(14).text(v, x + 3, y + 22, { width: boxW - 6, align: 'center' });
  });
  y += 62;
  if (r.gradeRemark) doc.fillColor('#334155').font('Helvetica-Oblique').fontSize(10).text(`Remarks: ${r.gradeRemark}`, left, y);
  const sigY = doc.page.height - 110;
  doc.font('Helvetica').fontSize(9).fillColor('#334155');
  ['Class Teacher', 'Parent / Guardian', h.branding.principalName ? `Principal (${h.branding.principalName})` : 'Principal'].forEach((label, i) => {
    const x = left + (i * width) / 3;
    doc.moveTo(x + 10, sigY).lineTo(x + width / 3 - 10, sigY).strokeColor('#cbd5e1').stroke();
    doc.text(label, x, sigY + 5, { width: width / 3, align: 'center' });
  });
}

export async function reportCardPdf(ctx: Ctx, examId: string, f: { studentId?: string; sectionId?: string }) {
  requirePermission(ctx, 'exams.view');
  const exam = await getExam(ctx, examId);
  if (ctx.scope === 'own' && exam.status !== 'published') throw forbidden('Results have not been published yet');
  if (!f.studentId && !f.sectionId) throw badRequest('Choose a student or a section');
  if (f.studentId) await assertStudentAccess(ctx, f.studentId);
  if (f.sectionId) await assertSectionAccess(ctx, f.sectionId);
  const all = await computeResults(ctx, examId);
  const [year] = await ctx.db.select().from(academicYears).where(eq(academicYears.id, exam.academicYearId));
  const list = all.results.filter((r) => (f.studentId ? r.studentId === f.studentId : r.sectionId === f.sectionId));
  if (!list.length) throw badRequest('No results found');
  const h = await loadSchoolHeader(ctx.schoolId);
  const doc = createDoc();
  for (const [i, r] of list.entries()) {
    if (i > 0) doc.addPage();
    const classSize = all.classSizes[r.className] ?? 0;
    drawReportCard(doc, h, exam, year.name, r, await attendancePct(ctx, r.studentId, exam.academicYearId), classSize);
  }
  footer(doc, h, h.branding.reportCardFooter ?? 'This is a computer-generated report card.');
  const name = list.length === 1 ? `report-card-${list[0].admissionNo}.pdf` : `report-cards-${list[0].className}-${list[0].sectionName}.pdf`;
  return { buffer: await toBuffer(doc), filename: name };
}

/** Sections the caller teaches — used by the marks-entry UI. */
export async function myTeachingSections(ctx: Ctx) {
  return ctx.scope === 'assigned' ? teacherSectionIds(ctx) : null;
}
