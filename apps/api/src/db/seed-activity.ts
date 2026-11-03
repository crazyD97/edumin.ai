/** Operational demo data: attendance, fees, exams, timetable, homework, communication. */
import { and, eq, sql } from 'drizzle-orm';
import { ALL_FEATURES, ALL_PERMISSIONS } from '@edumin/shared';
import { db } from '../core/db';
import { createCtx } from '../core/context';
import {
  admissionApplications,
  admissionEnquiries,
  announcements,
  assignments,
  attendanceRecords,
  enrollments,
  events,
  examPapers,
  exams,
  feeConcessions,
  feeInvoices,
  feeHeads,
  feeStructures,
  leaveRequests,
  marks,
  meetingSlots,
  meetings,
  periods,
  staffAttendance,
  submissions,
  timetableEntries,
  sectionSubjects,
  notifications,
  type academicYears,
  type classes,
  type sections,
  type subjects,
  type users,
} from './schema';
import { generateInvoices, recordPayment, applyLateFees } from '../modules/fees/service';

export interface ActivityInput {
  schoolId: string;
  large: boolean;
  current: typeof academicYears.$inferSelect;
  previous: typeof academicYears.$inferSelect;
  teachers: (typeof users.$inferSelect)[];
  adminIds: string[];
  classRows: (typeof classes.$inferSelect)[];
  subjectRows: (typeof subjects.$inferSelect)[];
  curSections: (typeof sections.$inferSelect)[];
  prevSections: (typeof sections.$inferSelect)[];
  students: { id: string; sectionId: string }[];
  demo: { studentId: string; sectionId: string; parentUserId: string; studentUserId: string };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400_000));
/** Deterministic pseudo-random in [0,1) so the demo looks the same every seed. */
function rng(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
const isSchoolDay = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay() !== 0;

export async function seedActivity(i: ActivityInput) {
  const rand = rng(i.large ? 42 : 7);
  // The school admin created by provisioning.
  const [adminUser] = await db.execute<{ id: string }>(
    sql`select u.id from users u join roles r on r.id = u.role_id where u.school_id = ${i.schoolId} and r.key = 'school_admin' limit 1`,
  );
  const ctx = createCtx({ userId: adminUser.id, schoolId: i.schoolId, roleKey: 'school_admin', scope: 'school', permissions: new Set(ALL_PERMISSIONS), features: new Set(ALL_FEATURES) });
  const today = iso(new Date());

  // ── Attendance: last ~45 days of the current year, plus 60 days of last year ──
  const studentBias = new Map(i.students.map((s) => [s.id, 0.75 + rand() * 0.24])); // each student's typical presence
  const attRows: (typeof attendanceRecords.$inferInsert)[] = [];
  const markDays = (from: string, to: string, sectionOf: (s: { id: string; sectionId: string }) => string | undefined) => {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (!isSchoolDay(d)) continue;
      for (const s of i.students) {
        const sec = sectionOf(s);
        if (!sec) continue;
        const r = rand();
        const p = studentBias.get(s.id)!;
        const status = r < p ? 'present' : r < p + 0.04 ? 'late' : r < p + 0.06 ? 'half_day' : 'absent';
        attRows.push({ schoolId: i.schoolId, studentId: s.id, sectionId: sec, date: d, status, markedBy: i.teachers[0].id });
      }
    }
  };
  const curFrom = [addDays(today, -45), i.current.startDate].sort()[1];
  markDays(curFrom, addDays(today, -1), (s) => s.sectionId);
  // Today: mark only some sections so the dashboard shows progress.
  if (isSchoolDay(today)) markDays(today, today, (s) => (i.curSections.findIndex((c) => c.id === s.sectionId) % 3 !== 0 ? s.sectionId : undefined));
  const prevEnroll = await db.select().from(enrollments).where(eq(enrollments.academicYearId, i.previous.id));
  const prevSecOf = new Map(prevEnroll.map((e) => [e.studentId, e.sectionId]));
  markDays(addDays(i.previous.endDate, -75), addDays(i.previous.endDate, -15), (s) => prevSecOf.get(s.id));
  for (let k = 0; k < attRows.length; k += 2000) await db.insert(attendanceRecords).values(attRows.slice(k, k + 2000)).onConflictDoNothing();

  const staff = [...i.teachers.map((t) => t.id), ...i.adminIds];
  const staffRows = [];
  for (let d = curFrom; d < today; d = addDays(d, 1)) {
    if (!isSchoolDay(d)) continue;
    for (const u of staff) staffRows.push({ schoolId: i.schoolId, userId: u, date: d, status: rand() < 0.95 ? 'present' : 'absent', markedBy: adminUser.id });
  }
  if (staffRows.length) await db.insert(staffAttendance).values(staffRows).onConflictDoNothing();

  // ── Timetable ──
  const ps = (await db.select().from(periods).where(eq(periods.schoolId, i.schoolId))).filter((p) => !p.isBreak).sort((a, b) => a.sortOrder - b.sortOrder);
  const busy = new Set<string>();
  const ttRows: (typeof timetableEntries.$inferInsert)[] = [];
  for (const sec of i.curSections) {
    const subs = await db.select().from(sectionSubjects).where(eq(sectionSubjects.sectionId, sec.id));
    for (let day = 1; day <= 6; day++) {
      ps.forEach((p, pi) => {
        if (day === 6 && pi >= 4) return; // half day Saturday
        for (let tries = 0; tries < subs.length; tries++) {
          const ss = subs[(day + pi + tries) % subs.length];
          const key = `${ss.teacherId}|${day}|${p.id}`;
          if (ss.teacherId && busy.has(key)) continue;
          if (ss.teacherId) busy.add(key);
          ttRows.push({ schoolId: i.schoolId, sectionId: sec.id, dayOfWeek: day, periodId: p.id, subjectId: ss.subjectId, teacherId: ss.teacherId, room: sec.room });
          break;
        }
      });
    }
  }
  if (ttRows.length) await db.insert(timetableEntries).values(ttRows);

  // ── Exams: last year (2 published), this year (1 published, 1 upcoming) ──
  const [scale] = await db.execute<{ id: string }>(sql`select id from grading_scales where school_id = ${i.schoolId} and is_default limit 1`);
  const mkExam = async (yearId: string, name: string, term: string, start: string, status: string, secs: typeof i.curSections, enrollOf: (sectionId: string) => Promise<string[]>, skill: number) => {
    const [e] = await db
      .insert(exams)
      .values({ schoolId: i.schoolId, academicYearId: yearId, name, term, gradingScaleId: scale.id, startDate: start, endDate: addDays(start, 7), status, approvedBy: status === 'published' ? adminUser.id : null, approvedAt: status === 'published' ? new Date(addDays(start, 14)) : null })
      .returning();
    const paperIds = new Map<string, string>();
    for (const c of i.classRows) {
      const rows = await db
        .insert(examPapers)
        .values(i.subjectRows.map((s, k) => ({ schoolId: i.schoolId, examId: e.id, classId: c.id, subjectId: s.id, date: addDays(start, k), startTime: '09:00', endTime: '12:00', maxMarks: 100, passMarks: 33 })))
        .returning();
      for (const r of rows) paperIds.set(`${c.id}|${r.subjectId}`, r.id);
    }
    if (status === 'scheduled') return e;
    const markRows: (typeof marks.$inferInsert)[] = [];
    for (const sec of secs) {
      for (const sid of await enrollOf(sec.id)) {
        const ability = (studentBias.get(sid) ?? 0.8) * 100 * skill;
        for (const s of i.subjectRows) {
          const absent = rand() < 0.015;
          const v = Math.max(8, Math.min(100, Math.round(ability - 20 + rand() * 35)));
          markRows.push({ schoolId: i.schoolId, paperId: paperIds.get(`${sec.classId}|${s.id}`)!, studentId: sid, marksObtained: absent ? null : v, isAbsent: absent, enteredBy: i.teachers[0].id });
        }
      }
    }
    for (let k = 0; k < markRows.length; k += 2000) await db.insert(marks).values(markRows.slice(k, k + 2000));
    return e;
  };
  const enrolledIn = async (sectionId: string) => (await db.select({ id: enrollments.studentId }).from(enrollments).where(eq(enrollments.sectionId, sectionId))).map((r) => r.id);
  await mkExam(i.previous.id, 'Half Yearly Examination', 'Term 1', addDays(i.previous.startDate, 170), 'published', i.prevSections, enrolledIn, 0.92);
  await mkExam(i.previous.id, 'Annual Examination', 'Term 2', addDays(i.previous.endDate, -40), 'published', i.prevSections, enrolledIn, 0.97);
  const firstTermStart = [addDays(today, -40), addDays(i.current.startDate, 7)].sort()[1];
  await mkExam(i.current.id, 'Unit Test 1', 'Term 1', firstTermStart, 'published', i.curSections, enrolledIn, 0.95);
  await mkExam(i.current.id, 'Half Yearly Examination', 'Term 1', addDays(today, 18), 'scheduled', i.curSections, enrolledIn, 1);

  // ── Fees ──
  const heads = await db.select().from(feeHeads).where(eq(feeHeads.schoolId, i.schoolId));
  const head = (n: string) => heads.find((h) => h.name === n)!.id;
  for (const c of i.classRows) {
    await db.insert(feeStructures).values([
      { schoolId: i.schoolId, academicYearId: i.current.id, feeHeadId: head('Tuition Fee'), classId: c.id, name: 'Tuition Fee', amount: 2500 + c.level * 250, frequency: 'monthly', dueDay: 10, lateFeeAmount: 100 },
      { schoolId: i.schoolId, academicYearId: i.current.id, feeHeadId: head('Examination Fee'), classId: c.id, name: 'Examination Fee', amount: 1200, frequency: 'annual', dueDay: 15, lateFeeAmount: 0 },
    ]);
  }
  // A few concessions
  for (const [k, s] of i.students.filter((_, idx) => idx % 17 === 0).entries()) {
    await db.insert(feeConcessions).values({ schoolId: i.schoolId, studentId: s.id, academicYearId: i.current.id, feeHeadId: head('Tuition Fee'), kind: k % 2 ? 'scholarship' : 'discount', valueType: 'percent', value: k % 2 ? 50 : 10, reason: k % 2 ? 'Merit scholarship' : 'Sibling discount', createdBy: adminUser.id });
  }
  await generateInvoices(ctx, { upToDate: addDays(today, 31) });
  // Payments: most students paid most dues; some defaulters.
  const methods = ['cash', 'upi', 'bank_transfer', 'card', 'cheque'] as const;
  for (const [idx, s] of i.students.entries()) {
    const invs = await db.select().from(feeInvoices).where(and(eq(feeInvoices.studentId, s.id), eq(feeInvoices.academicYearId, i.current.id)));
    const due = invs.filter((v) => v.dueDate < (idx % 2 === 0 ? addDays(today, 10) : today)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const payCount = idx % 9 === 0 ? Math.max(0, due.length - 3) : idx % 5 === 0 ? due.length - 1 : due.length;
    for (const v of due.slice(0, Math.max(0, payCount))) {
      const net = v.amount - v.discount - v.scholarship;
      const partial = idx % 13 === 0 && v === due[payCount - 1];
      const paidOn = [addDays(v.dueDate, -Math.floor(rand() * 8)), addDays(today, -(idx % 3))].sort()[0];
      await recordPayment(ctx, { studentId: s.id, amount: partial ? Math.round(net / 2) : net, method: methods[idx % methods.length], paidAt: paidOn, reference: idx % 5 === 1 ? `TXN${100000 + idx}` : null, invoiceIds: [v.id] });
    }
  }
  await applyLateFees(ctx);

  // ── Homework ──
  for (const [k, sec] of i.curSections.entries()) {
    const subs = await db.select().from(sectionSubjects).where(eq(sectionSubjects.sectionId, sec.id));
    for (let h = 0; h < 3; h++) {
      const ss = subs[(k + h) % subs.length];
      const subjectName = i.subjectRows.find((x) => x.id === ss.subjectId)!.name;
      const due = addDays(today, h === 0 ? -5 : h === 1 ? 2 : 6);
      const [a] = await db
        .insert(assignments)
        .values({ schoolId: i.schoolId, sectionId: sec.id, subjectId: ss.subjectId, teacherId: ss.teacherId, title: `${subjectName}: ${['Chapter review questions', 'Worksheet practice', 'Project research'][h]}`, description: 'Complete the exercises in your notebook and upload a photo or summary of your work.', dueDate: due, maxMarks: 10 })
        .returning();
      if (h === 0) {
        const studs = await enrolledIn(sec.id);
        const rows = studs.filter(() => rand() < 0.8).map((sid) => {
          const graded = rand() < 0.6;
          return { schoolId: i.schoolId, assignmentId: a.id, studentId: sid, content: 'Completed all questions.', status: graded ? 'graded' : 'submitted', submittedAt: new Date(addDays(due, -1)), marks: graded ? 6 + Math.floor(rand() * 5) : null, feedback: graded ? 'Good work.' : null, gradedBy: graded ? ss.teacherId : null };
        });
        if (rows.length) await db.insert(submissions).values(rows);
      }
    }
  }

  // ── Admissions ──
  const names = ['Ira Kapoor', 'Advik Rao', 'Mira Shah', 'Yash Jain', 'Sara Thomas', 'Kian Bose', 'Nila Pillai', 'Rudra Das'];
  for (const [k, n] of names.entries()) {
    const cls = i.classRows[k % i.classRows.length];
    await db.insert(admissionEnquiries).values({ schoolId: i.schoolId, studentName: n, guardianName: `Parent of ${n.split(' ')[0]}`, phone: `98860${String(10000 + k)}`, email: `enquiry${k}@example.com`, classId: cls.id, source: k % 2 ? 'website' : 'walk_in', status: k < 3 ? 'new' : k < 6 ? 'contacted' : 'converted', message: 'Interested in admission for the coming term.', createdAt: new Date(addDays(today, -k * 4)) });
  }
  const appStatuses = ['submitted', 'submitted', 'under_review', 'approved', 'rejected'];
  for (const [k, st] of appStatuses.entries()) {
    const n = names[k];
    await db.insert(admissionApplications).values({
      schoolId: i.schoolId,
      applicationNo: `APP${new Date().getFullYear()}${String(k + 1).padStart(4, '0')}`,
      academicYearId: i.current.id,
      classId: i.classRows[(k + 1) % i.classRows.length].id,
      student: { firstName: n.split(' ')[0], lastName: n.split(' ')[1], dateOfBirth: '2016-05-12', gender: k % 2 ? 'male' : 'female', previousSchool: 'Little Stars School' },
      guardian: { name: `Parent of ${n.split(' ')[0]}`, relation: 'mother', phone: `98860${String(20000 + k)}`, email: `applicant${k}@example.com` },
      status: st,
      createdAt: new Date(addDays(today, -k * 3)),
    });
  }
  await db.execute(sql`insert into sequences (school_id, key, value) values (${i.schoolId}, 'application', ${appStatuses.length}) on conflict do nothing`);

  // ── Communication & calendar ──
  await db.insert(announcements).values([
    { schoolId: i.schoolId, title: 'Half Yearly Examination schedule released', body: 'The Half Yearly Examination begins in under three weeks. The subject-wise schedule is available under Examinations. Students should collect their admit cards from the class teacher.', category: 'exam', audience: 'all', isPinned: true, createdBy: adminUser.id, createdAt: new Date(addDays(today, -1)) },
    { schoolId: i.schoolId, title: 'Monthly fee reminder', body: 'Tuition fees for this month are due on the 10th. A late fee applies after the due date. Pay online from the parent portal or at the accounts office.', category: 'fee', audience: 'parents', createdBy: adminUser.id, createdAt: new Date(addDays(today, -4)) },
    { schoolId: i.schoolId, title: 'Staff meeting on Friday', body: 'All teaching staff are requested to attend the academic review meeting on Friday at 3:30 PM in the conference room.', category: 'general', audience: 'staff', createdBy: adminUser.id, createdAt: new Date(addDays(today, -2)) },
    { schoolId: i.schoolId, title: 'Annual Sports Day registrations open', body: 'Students can register for track and field events with their PE teacher until the end of next week.', category: 'event', audience: 'all', createdBy: adminUser.id, createdAt: new Date(addDays(today, -6)) },
  ]);
  await db.insert(events).values([
    { schoolId: i.schoolId, title: 'Annual Sports Day', type: 'sports', startDate: addDays(today, 12), endDate: addDays(today, 12), startTime: '08:30', location: 'Main Ground', description: 'Track and field events, march past and prize distribution.', createdBy: adminUser.id },
    { schoolId: i.schoolId, title: 'Parent–Teacher Meeting', type: 'ptm', startDate: addDays(today, 6), endDate: addDays(today, 6), startTime: '10:00', location: 'Respective classrooms', description: 'Discuss Unit Test 1 performance.', createdBy: adminUser.id },
    { schoolId: i.schoolId, title: 'Diwali Holidays', type: 'holiday', startDate: addDays(today, 25), endDate: addDays(today, 29), description: 'School remains closed.', createdBy: adminUser.id },
    { schoolId: i.schoolId, title: 'Annual Day Celebration', type: 'function', startDate: addDays(today, 40), endDate: addDays(today, 40), startTime: '17:00', location: 'School Auditorium', createdBy: adminUser.id },
    { schoolId: i.schoolId, title: 'Science Exhibition', type: 'event', startDate: addDays(today, 3), endDate: addDays(today, 4), location: 'Science Block', classIds: i.classRows.filter((c) => c.level >= 6).map((c) => c.id), createdBy: adminUser.id },
  ]);

  // ── Meetings: slots for the demo student's class teacher, one approved meeting ──
  const demoSec = i.curSections.find((s) => s.id === i.demo.sectionId)!;
  const ct = demoSec.classTeacherId!;
  const slotDay = addDays(today, 3);
  const slots = await db
    .insert(meetingSlots)
    .values([0, 1, 2, 3].map((k) => ({ schoolId: i.schoolId, teacherId: ct, startsAt: new Date(new Date(`${slotDay}T15:00:00`).getTime() + k * 15 * 60000), endsAt: new Date(new Date(`${slotDay}T15:00:00`).getTime() + (k + 1) * 15 * 60000), location: `Room ${demoSec.room}` })))
    .returning();
  await db.update(meetingSlots).set({ isBooked: true }).where(eq(meetingSlots.id, slots[0].id));
  await db.insert(meetings).values({ schoolId: i.schoolId, teacherId: ct, parentUserId: i.demo.parentUserId, studentId: i.demo.studentId, slotId: slots[0].id, startsAt: slots[0].startsAt, endsAt: slots[0].endsAt, location: slots[0].location, agenda: 'Discuss progress in Mathematics', status: 'approved', requestedBy: i.demo.parentUserId });
  await db.insert(meetings).values({ schoolId: i.schoolId, teacherId: ct, parentUserId: i.demo.parentUserId, studentId: i.demo.studentId, startsAt: new Date(addDays(today, -30) + 'T15:00:00'), endsAt: new Date(addDays(today, -30) + 'T15:15:00'), location: `Room ${demoSec.room}`, agenda: 'Settling in after the summer break', status: 'completed', notes: 'Student is adjusting well; encouraged more reading at home.', requestedBy: ct });

  // ── Leave ──
  await db.insert(leaveRequests).values([
    { schoolId: i.schoolId, requesterId: i.demo.parentUserId, studentId: i.demo.studentId, fromDate: addDays(today, 8), toDate: addDays(today, 9), type: 'family', reason: 'Family function out of town', status: 'pending' },
    { schoolId: i.schoolId, requesterId: i.teachers[1].id, fromDate: addDays(today, 4), toDate: addDays(today, 4), type: 'casual', reason: 'Personal work', status: 'pending' },
  ]);

  // Welcome notification for each demo login
  await db.insert(notifications).values(
    [adminUser.id, i.demo.parentUserId, i.demo.studentUserId, ct].map((u) => ({ schoolId: i.schoolId, userId: u, type: 'welcome', title: 'Welcome to your school portal', body: 'Explore your dashboard to get started.', link: '/' })),
  );
}
