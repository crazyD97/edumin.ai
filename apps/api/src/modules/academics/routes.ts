/** Academic structure: years, classes, sections, subjects and teacher allocation. */
import { z } from 'zod';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { academicYears, classes, enrollments, sectionSubjects, sections, subjects, users } from '../../db/schema';
import { badRequest, conflict, must } from '../../core/errors';
import { ctxOf, guard, idParam, ok, optStr, optUuid, typed, type App } from '../../core/http';
import { currentYearId, scopedSectionIds, type Ctx } from '../../core/context';
import { audit } from '../../core/audit';

export async function resolveYearId(ctx: Ctx, yearId?: string | null) {
  if (yearId) {
    const [y] = await ctx.db.select({ id: academicYears.id }).from(academicYears).where(and(eq(academicYears.id, yearId), eq(academicYears.schoolId, ctx.schoolId)));
    return must(y, 'Academic year').id;
  }
  const cur = await currentYearId(ctx);
  if (!cur) throw badRequest('No current academic year is set. Create one under Academics → Academic Years.');
  return cur;
}

export async function getSection(ctx: Ctx, sectionId: string) {
  const [s] = await ctx.db.select().from(sections).where(and(eq(sections.id, sectionId), eq(sections.schoolId, ctx.schoolId)));
  return must(s, 'Section');
}

/** Sections with class name, for the given year, restricted to the caller's scope. */
export async function listSections(ctx: Ctx, yearId: string) {
  const scoped = await scopedSectionIds(ctx);
  if (scoped && !scoped.length) return [];
  return ctx.db
    .select({
      id: sections.id,
      name: sections.name,
      classId: classes.id,
      className: classes.name,
      classLevel: classes.level,
      label: sql<string>`${classes.name} || ' - ' || ${sections.name}`,
      classTeacherId: sections.classTeacherId,
      classTeacherName: users.fullName,
      capacity: sections.capacity,
      room: sections.room,
      academicYearId: sections.academicYearId,
      studentCount: sql<number>`(select count(*)::int from ${enrollments} where ${enrollments.sectionId} = ${sections.id} and ${enrollments.status} = 'active')`,
    })
    .from(sections)
    .innerJoin(classes, eq(classes.id, sections.classId))
    .leftJoin(users, eq(users.id, sections.classTeacherId))
    .where(and(eq(sections.schoolId, ctx.schoolId), eq(sections.academicYearId, yearId), scoped ? inArray(sections.id, scoped) : undefined))
    .orderBy(asc(classes.level), asc(classes.name), asc(sections.name));
}

async function assertTeacher(ctx: Ctx, userId: string | null | undefined) {
  if (!userId) return;
  const [u] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.schoolId, ctx.schoolId)));
  must(u, 'Teacher');
}

export async function academicRoutes(app: App) {
  const r = typed(app);

  // ── Academic years ──
  r.get('/academic-years', { schema: { tags: ['Academics'] } }, async (req) => {
    const ctx = ctxOf(req);
    return ok(await ctx.db.select().from(academicYears).where(eq(academicYears.schoolId, ctx.schoolId)).orderBy(sql`${academicYears.startDate} desc`));
  });

  const yearBody = z
    .object({ name: z.string().trim().min(2).max(50), startDate: z.iso.date(), endDate: z.iso.date(), isCurrent: z.boolean().default(false) })
    .refine((v) => v.endDate > v.startDate, { message: 'End date must be after start date', path: ['endDate'] });

  r.post('/academic-years', { preValidation: guard('academics.create'), schema: { tags: ['Academics'], body: yearBody } }, async (req) => {
    const ctx = ctxOf(req);
    const row = await ctx.db.transaction(async (tx) => {
      if (req.body.isCurrent) await tx.update(academicYears).set({ isCurrent: false }).where(eq(academicYears.schoolId, ctx.schoolId));
      const [y] = await tx.insert(academicYears).values({ ...req.body, schoolId: ctx.schoolId }).returning();
      return y;
    });
    await audit(ctx, 'create', 'academic_year', row.id);
    return ok(row);
  });

  r.put('/academic-years/:id', { preValidation: guard('academics.edit'), schema: { tags: ['Academics'], params: idParam, body: yearBody } }, async (req) => {
    const ctx = ctxOf(req);
    const row = await ctx.db.transaction(async (tx) => {
      if (req.body.isCurrent) await tx.update(academicYears).set({ isCurrent: false }).where(eq(academicYears.schoolId, ctx.schoolId));
      const [y] = await tx
        .update(academicYears)
        .set(req.body)
        .where(and(eq(academicYears.id, req.params.id), eq(academicYears.schoolId, ctx.schoolId)))
        .returning();
      return must(y, 'Academic year');
    });
    return ok(row);
  });

  r.delete('/academic-years/:id', { preValidation: guard('academics.delete'), schema: { tags: ['Academics'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    const [{ n }] = await ctx.db.select({ n: count() }).from(enrollments).where(eq(enrollments.academicYearId, req.params.id));
    if (n) throw conflict('This academic year has student enrollments and is part of the academic history. It cannot be deleted.');
    await ctx.db.delete(academicYears).where(and(eq(academicYears.id, req.params.id), eq(academicYears.schoolId, ctx.schoolId)));
    return ok({ deleted: true });
  });

  /** Copies sections and subject allocations from one year into another. */
  r.post(
    '/academic-years/:id/copy-structure',
    { preValidation: guard('academics.create'), schema: { tags: ['Academics'], params: idParam, body: z.object({ fromYearId: z.uuid() }) } },
    async (req) => {
      const ctx = ctxOf(req);
      const toYear = await resolveYearId(ctx, req.params.id);
      const fromYear = await resolveYearId(ctx, req.body.fromYearId);
      if (toYear === fromYear) throw badRequest('Choose a different source year');
      const src = await ctx.db.select().from(sections).where(and(eq(sections.schoolId, ctx.schoolId), eq(sections.academicYearId, fromYear)));
      let created = 0;
      await ctx.db.transaction(async (tx) => {
        for (const s of src) {
          const [n] = await tx
            .insert(sections)
            .values({ schoolId: ctx.schoolId, academicYearId: toYear, classId: s.classId, name: s.name, classTeacherId: s.classTeacherId, capacity: s.capacity, room: s.room })
            .onConflictDoNothing()
            .returning();
          if (!n) continue;
          created++;
          const subs = await tx.select().from(sectionSubjects).where(eq(sectionSubjects.sectionId, s.id));
          if (subs.length) await tx.insert(sectionSubjects).values(subs.map((x) => ({ schoolId: ctx.schoolId, sectionId: n.id, subjectId: x.subjectId, teacherId: x.teacherId })));
        }
      });
      return ok({ sectionsCreated: created });
    },
  );

  // ── Classes ──
  r.get('/classes', { schema: { tags: ['Academics'] } }, async (req) => {
    const ctx = ctxOf(req);
    return ok(await ctx.db.select().from(classes).where(eq(classes.schoolId, ctx.schoolId)).orderBy(asc(classes.level), asc(classes.name)));
  });
  const classBody = z.object({ name: z.string().trim().min(1).max(50), level: z.coerce.number().int().min(0).max(100) });
  r.post('/classes', { preValidation: guard('academics.create'), schema: { tags: ['Academics'], body: classBody } }, async (req) => {
    const ctx = ctxOf(req);
    const [row] = await ctx.db.insert(classes).values({ ...req.body, schoolId: ctx.schoolId }).returning();
    return ok(row);
  });
  r.put('/classes/:id', { preValidation: guard('academics.edit'), schema: { tags: ['Academics'], params: idParam, body: classBody } }, async (req) => {
    const ctx = ctxOf(req);
    const [row] = await ctx.db.update(classes).set(req.body).where(and(eq(classes.id, req.params.id), eq(classes.schoolId, ctx.schoolId))).returning();
    return ok(must(row, 'Class'));
  });
  r.delete('/classes/:id', { preValidation: guard('academics.delete'), schema: { tags: ['Academics'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    const [{ n }] = await ctx.db
      .select({ n: count() })
      .from(enrollments)
      .innerJoin(sections, eq(sections.id, enrollments.sectionId))
      .where(eq(sections.classId, req.params.id));
    if (n) throw conflict('Students have been enrolled in this class; it cannot be deleted.');
    await ctx.db.delete(classes).where(and(eq(classes.id, req.params.id), eq(classes.schoolId, ctx.schoolId)));
    return ok({ deleted: true });
  });

  // ── Sections ──
  r.get('/sections', { schema: { tags: ['Academics'], querystring: z.object({ academicYearId: z.uuid().optional() }) } }, async (req) => {
    const ctx = ctxOf(req);
    const yearId = await resolveYearId(ctx, req.query.academicYearId);
    return ok(await listSections(ctx, yearId));
  });

  const sectionBody = z.object({
    classId: z.uuid(),
    name: z.string().trim().min(1).max(20),
    academicYearId: z.uuid().optional(),
    classTeacherId: optUuid,
    capacity: z.coerce.number().int().positive().nullish(),
    room: optStr,
  });
  r.post('/sections', { preValidation: guard('academics.create'), schema: { tags: ['Academics'], body: sectionBody } }, async (req) => {
    const ctx = ctxOf(req);
    const yearId = await resolveYearId(ctx, req.body.academicYearId);
    must((await ctx.db.select({ id: classes.id }).from(classes).where(and(eq(classes.id, req.body.classId), eq(classes.schoolId, ctx.schoolId))))[0], 'Class');
    await assertTeacher(ctx, req.body.classTeacherId);
    const [row] = await ctx.db
      .insert(sections)
      .values({ ...req.body, academicYearId: yearId, schoolId: ctx.schoolId })
      .returning();
    return ok(row);
  });
  r.put('/sections/:id', { preValidation: guard('academics.edit'), schema: { tags: ['Academics'], params: idParam, body: sectionBody.omit({ classId: true, academicYearId: true }) } }, async (req) => {
    const ctx = ctxOf(req);
    await assertTeacher(ctx, req.body.classTeacherId);
    const [row] = await ctx.db.update(sections).set(req.body).where(and(eq(sections.id, req.params.id), eq(sections.schoolId, ctx.schoolId))).returning();
    return ok(must(row, 'Section'));
  });
  r.delete('/sections/:id', { preValidation: guard('academics.delete'), schema: { tags: ['Academics'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    const [{ n }] = await ctx.db.select({ n: count() }).from(enrollments).where(eq(enrollments.sectionId, req.params.id));
    if (n) throw conflict('Students are enrolled in this section. Move them first.');
    await ctx.db.delete(sections).where(and(eq(sections.id, req.params.id), eq(sections.schoolId, ctx.schoolId)));
    return ok({ deleted: true });
  });

  // ── Subjects ──
  r.get('/subjects', { schema: { tags: ['Academics'] } }, async (req) => {
    const ctx = ctxOf(req);
    return ok(await ctx.db.select().from(subjects).where(eq(subjects.schoolId, ctx.schoolId)).orderBy(asc(subjects.name)));
  });
  const subjectBody = z.object({ name: z.string().trim().min(1).max(100), code: optStr, type: z.enum(['theory', 'practical', 'activity']).default('theory') });
  r.post('/subjects', { preValidation: guard('academics.create'), schema: { tags: ['Academics'], body: subjectBody } }, async (req) => {
    const ctx = ctxOf(req);
    const [row] = await ctx.db.insert(subjects).values({ ...req.body, schoolId: ctx.schoolId }).returning();
    return ok(row);
  });
  r.put('/subjects/:id', { preValidation: guard('academics.edit'), schema: { tags: ['Academics'], params: idParam, body: subjectBody } }, async (req) => {
    const ctx = ctxOf(req);
    const [row] = await ctx.db.update(subjects).set(req.body).where(and(eq(subjects.id, req.params.id), eq(subjects.schoolId, ctx.schoolId))).returning();
    return ok(must(row, 'Subject'));
  });
  r.delete('/subjects/:id', { preValidation: guard('academics.delete'), schema: { tags: ['Academics'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    await ctx.db.delete(subjects).where(and(eq(subjects.id, req.params.id), eq(subjects.schoolId, ctx.schoolId)));
    return ok({ deleted: true });
  });

  // ── Subject allocation per section ──
  r.get('/sections/:id/subjects', { schema: { tags: ['Academics'], params: idParam } }, async (req) => {
    const ctx = ctxOf(req);
    await getSection(ctx, req.params.id);
    const rows = await ctx.db
      .select({ id: sectionSubjects.id, subjectId: subjects.id, subjectName: subjects.name, subjectCode: subjects.code, teacherId: sectionSubjects.teacherId, teacherName: users.fullName })
      .from(sectionSubjects)
      .innerJoin(subjects, eq(subjects.id, sectionSubjects.subjectId))
      .leftJoin(users, eq(users.id, sectionSubjects.teacherId))
      .where(eq(sectionSubjects.sectionId, req.params.id))
      .orderBy(asc(subjects.name));
    return ok(rows);
  });

  r.put(
    '/sections/:id/subjects',
    {
      preValidation: guard('academics.edit'),
      schema: {
        tags: ['Academics'],
        summary: 'Replace the subject list and subject teachers for a section',
        params: idParam,
        body: z.object({ items: z.array(z.object({ subjectId: z.uuid(), teacherId: optUuid })) }),
      },
    },
    async (req) => {
      const ctx = ctxOf(req);
      await getSection(ctx, req.params.id);
      for (const i of req.body.items) await assertTeacher(ctx, i.teacherId);
      const subjectIds = req.body.items.map((i) => i.subjectId);
      if (subjectIds.length) {
        const found = await ctx.db.select({ id: subjects.id }).from(subjects).where(and(eq(subjects.schoolId, ctx.schoolId), inArray(subjects.id, subjectIds)));
        if (found.length !== new Set(subjectIds).size) throw badRequest('Unknown subject in list');
      }
      await ctx.db.transaction(async (tx) => {
        await tx.delete(sectionSubjects).where(eq(sectionSubjects.sectionId, req.params.id));
        if (req.body.items.length)
          await tx.insert(sectionSubjects).values(req.body.items.map((i) => ({ schoolId: ctx.schoolId, sectionId: req.params.id, subjectId: i.subjectId, teacherId: i.teacherId ?? null })));
      });
      return ok({ saved: req.body.items.length });
    },
  );

  /** Bulk: apply one subject list to all sections of a class. */
  r.post(
    '/classes/:id/apply-subjects',
    { preValidation: guard('academics.edit'), schema: { tags: ['Academics'], params: idParam, body: z.object({ subjectIds: z.array(z.uuid()), academicYearId: z.uuid().optional() }) } },
    async (req) => {
      const ctx = ctxOf(req);
      const yearId = await resolveYearId(ctx, req.body.academicYearId);
      const secs = await ctx.db
        .select({ id: sections.id })
        .from(sections)
        .where(and(eq(sections.schoolId, ctx.schoolId), eq(sections.classId, req.params.id), eq(sections.academicYearId, yearId)));
      for (const s of secs) {
        for (const subjectId of req.body.subjectIds) {
          await ctx.db.insert(sectionSubjects).values({ schoolId: ctx.schoolId, sectionId: s.id, subjectId }).onConflictDoNothing();
        }
      }
      return ok({ sections: secs.length });
    },
  );
}
