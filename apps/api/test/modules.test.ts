import { describe, expect, it, beforeAll } from 'vitest';
import { client, login } from './helpers';

const today = new Date().toISOString().slice(0, 10);

describe('roles and data scope', () => {
  it('teachers only see their own sections and students', async () => {
    const admin = client(await login('admin@alpha.test'));
    const allSections = (await admin.get('/sections')).data;
    const teacherEmail = 'sneha.kulkarni@riverside.edu';
    const teacher = client(await login(teacherEmail));
    const mine = (await teacher.get('/sections')).data;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThanOrEqual(allSections.length);
    const myStudents = (await teacher.get('/students?pageSize=500')).data;
    const allowed = new Set(mine.map((s: any) => s.id));
    expect(myStudents.every((s: any) => allowed.has(s.sectionId))).toBe(true);
  });

  it('parents only see their own child', async () => {
    const parent = client(await login('parent@riverside.edu'));
    const kids = (await parent.get('/students')).data;
    expect(kids).toHaveLength(1);
    expect((await parent.post('/students', { firstName: 'X', guardians: [] })).status).toBe(403);
    expect((await parent.get('/staff')).status).toBe(403);
  });

  it('students and parents can resolve their own records without students.view', async () => {
    const student = client(await login('student@riverside.edu'));
    expect((await student.get('/students')).status).toBe(403);
    const mine = await student.get('/students/mine');
    expect(mine.status).toBe(200);
    expect(mine.data).toHaveLength(1);
    // A parent with one child doesn't need to choose the student when applying for leave.
    const parent = client(await login('parent@riverside.edu'));
    const leave = await parent.post('/leave', { fromDate: '2099-01-05', toDate: '2099-01-05', reason: 'Family function' });
    expect(leave.status).toBe(200);
    expect(leave.data.studentId).toBe(mine.data[0].id);
  });

  it('school admins can customise role permissions', async () => {
    const admin = client(await login('admin@alpha.test'));
    const roles = (await admin.get('/roles')).data;
    const acct = roles.find((r: any) => r.key === 'accountant');
    const without = acct.permissions.filter((p: string) => p !== 'fees.create');
    expect((await admin.put(`/roles/${acct.id}`, { name: acct.name, scope: acct.scope, permissions: without })).status).toBe(200);
    const accountant = client(await login('accounts@riverside.edu'));
    expect((await accountant.post('/fees/payments', { studentId: '00000000-0000-0000-0000-000000000000', amount: 1, method: 'cash' })).status).toBe(403);
    await admin.put(`/roles/${acct.id}`, { name: acct.name, scope: acct.scope, permissions: acct.permissions });
    const adminRole = roles.find((r: any) => r.key === 'school_admin');
    expect((await admin.put(`/roles/${adminRole.id}`, { name: 'Renamed', scope: 'school', permissions: [] })).status).toBe(403);
  });
});

describe('students & admissions', () => {
  let admin: ReturnType<typeof client>;
  beforeAll(async () => {
    admin = client(await login('admin@alpha.test'));
  });

  it('registers a student with generated admission number and shared guardian', async () => {
    const sec = (await admin.get('/sections')).data[0];
    const g = { name: 'Shared Parent', relation: 'mother', phone: '9000000001', email: 'shared.parent@test.dev', isPrimary: true };
    const a = await admin.post('/students', { firstName: 'Sib', lastName: 'One', sectionId: sec.id, guardians: [g] });
    const b = await admin.post('/students', { firstName: 'Sib', lastName: 'Two', sectionId: sec.id, guardians: [g] });
    expect(a.status).toBe(200);
    expect(a.data.admissionNo).toMatch(/^ADM\d{8}$/);
    expect(a.data.admissionNo).not.toBe(b.data.admissionNo);
    const pa = await admin.get(`/students/${a.data.id}`);
    const pb = await admin.get(`/students/${b.data.id}`);
    expect(pa.data.guardians[0].id).toBe(pb.data.guardians[0].id);
    expect(pa.data.current.sectionId).toBe(sec.id);
  });

  it('validates input with field-level errors', async () => {
    const res = await admin.post('/students', { firstName: '', email: 'not-an-email', guardians: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('runs an application from public submission to enrolled student', async () => {
    const pub = await (await import('./helpers')).getApp();
    const classes = (await admin.get('/classes')).data;
    const sub = await pub.inject({
      method: 'POST',
      url: '/api/public/schools/alpha/applications',
      payload: { classId: classes[0].id, student: { firstName: 'New', lastName: 'Applicant' }, guardian: { name: 'App Parent', phone: '9111111111' } },
    });
    expect(sub.statusCode).toBe(200);
    const id = sub.json().data.id;
    expect((await admin.post(`/admissions/applications/${id}/enroll`, { sectionId: (await admin.get('/sections')).data[0].id })).status).toBe(400);
    expect((await admin.post(`/admissions/applications/${id}/review`, { status: 'approved' })).status).toBe(200);
    const sections = (await admin.get('/sections')).data.filter((s: any) => s.classId === classes[0].id);
    const enrolled = await admin.post(`/admissions/applications/${id}/enroll`, { sectionId: sections[0].id });
    expect(enrolled.status).toBe(200);
    expect((await admin.get(`/students/${enrolled.data.studentId}`)).data.firstName).toBe('New');
  });

  it('promotes students into the next academic year, keeping history', async () => {
    const year = (await admin.post('/academic-years', { name: '2099-00', startDate: '2099-04-01', endDate: '2100-03-31', isCurrent: false })).data;
    const current = (await admin.get('/academic-years')).data.find((y: any) => y.isCurrent);
    await admin.post(`/academic-years/${year.id}/copy-structure`, { fromYearId: current.id });
    const from = (await admin.get('/sections')).data[0];
    const to = (await admin.get(`/sections?academicYearId=${year.id}`)).data.find((s: any) => s.className === from.className);
    const kids = (await admin.get(`/students?sectionId=${from.id}&pageSize=100`)).data;
    const res = await admin.post('/students/promote', {
      fromSectionId: from.id,
      toAcademicYearId: year.id,
      items: kids.map((k: any, i: number) => ({ studentId: k.id, action: i === 0 ? 'retain' : 'promote', toSectionId: to.id })),
    });
    expect(res.status).toBe(200);
    expect(res.data.promoted + res.data.retained).toBe(kids.length);
    const profile = await admin.get(`/students/${kids[1].id}`);
    expect(profile.data.history.some((h: any) => h.academicYearId === year.id)).toBe(true);
    expect(profile.data.history.find((h: any) => h.academicYearId === current.id).status).toBe('promoted');
  });
});

describe('attendance', () => {
  it('bulk-marks a section and computes percentages', async () => {
    const admin = client(await login('admin@alpha.test'));
    const sec = (await admin.get('/sections')).data[1];
    const date = new Date(Date.now() - 86400_000 * 400).toISOString().slice(0, 10);
    const sheet = (await admin.get(`/attendance/sheet?sectionId=${sec.id}&date=${date}`)).data;
    const records = sheet.students.map((s: any, i: number) => ({ studentId: s.studentId, status: i === 0 ? 'absent' : i === 1 ? 'half_day' : 'present' }));
    const res = await admin.post('/attendance/mark', { sectionId: sec.id, date, records });
    expect(res.status).toBe(200);
    expect(res.data.absent).toBe(1);
    const sum = (await admin.get(`/attendance/summary?sectionId=${sec.id}&from=${date}&to=${date}`)).data;
    const first = sum.find((x: any) => x.studentId === sheet.students[0].studentId);
    const second = sum.find((x: any) => x.studentId === sheet.students[1].studentId);
    expect(first.percentage).toBe(0);
    expect(second.percentage).toBe(50);
    expect((await admin.post('/attendance/mark', { sectionId: sec.id, date: '2999-01-01', records })).status).toBe(400);
  });

  it('stops teachers marking sections they do not teach', async () => {
    const teacher = client(await login('neha.shah@riverside.edu'));
    const admin = client(await login('admin@alpha.test'));
    const mine = new Set((await teacher.get('/sections')).data.map((s: any) => s.id));
    const other = (await admin.get('/sections')).data.find((s: any) => !mine.has(s.id));
    if (!other) return;
    const res = await teacher.post('/attendance/mark', { sectionId: other.id, date: today, records: [{ studentId: '00000000-0000-0000-0000-000000000000', status: 'present' }] });
    expect(res.status).toBe(403);
  });
});

describe('fees', () => {
  it('allocates partial payments oldest-first and blocks overpayment', async () => {
    const admin = client(await login('admin@alpha.test'));
    const student = (await admin.get('/students?pageSize=1')).data[0];
    const head = (await admin.get('/fees/heads')).data[0];
    await admin.post('/fees/structures', { feeHeadId: head.id, studentId: student.id, name: 'Lab fee', amount: 300, frequency: 'quarterly', dueDay: 5 });
    await admin.post('/fees/generate', {});
    const before = (await admin.get(`/fees/students/${student.id}/ledger`)).data;
    const lab = before.invoices.filter((i: any) => i.title.startsWith('Lab fee'));
    expect(lab).toHaveLength(4);
    // Generation is idempotent
    await admin.post('/fees/generate', {});
    expect((await admin.get(`/fees/students/${student.id}/ledger`)).data.invoices.filter((i: any) => i.title.startsWith('Lab fee'))).toHaveLength(4);

    const pay = await admin.post('/fees/payments', { studentId: student.id, amount: 450, method: 'cash', invoiceIds: lab.map((i: any) => i.id) });
    expect(pay.status).toBe(200);
    expect(pay.data.allocations.map((a: any) => a.amount)).toEqual([300, 150]);
    const after = (await admin.get(`/fees/students/${student.id}/ledger`)).data;
    const statuses = after.invoices.filter((i: any) => i.title.startsWith('Lab fee')).map((i: any) => i.status);
    expect(statuses).toEqual(['paid', 'partial', 'unpaid', 'unpaid']);
    expect((await admin.post('/fees/payments', { studentId: student.id, amount: 10_000_000, method: 'cash' })).status).toBe(400);
    const receipt = await admin.get(`/fees/payments/${pay.data.id}/receipt`);
    expect(receipt.status).toBe(200);
    expect(receipt.headers['content-type']).toBe('application/pdf');
  });

  it('applies concessions to new invoices', async () => {
    const admin = client(await login('admin@alpha.test'));
    const student = (await admin.get('/students?pageSize=2')).data[1];
    const head = (await admin.get('/fees/heads')).data.find((h: any) => h.name === 'Admission Fee');
    await admin.post('/fees/concessions', { studentId: student.id, feeHeadId: head.id, kind: 'scholarship', valueType: 'percent', value: 25 });
    await admin.post('/fees/structures', { feeHeadId: head.id, studentId: student.id, name: 'Admission', amount: 1000, frequency: 'one_time' });
    await admin.post('/fees/generate', {});
    const inv = (await admin.get(`/fees/students/${student.id}/ledger`)).data.invoices.find((i: any) => i.title === 'Admission');
    expect(inv.scholarship).toBe(250);
    expect(inv.balance).toBe(750);
  });
});

describe('examinations', () => {
  it('computes results, grades and competition ranks; locks marks on publish', async () => {
    const admin = client(await login('admin@alpha.test'));
    const classes = (await admin.get('/classes')).data;
    const subjects = (await admin.get('/subjects')).data.slice(0, 2);
    const exam = (await admin.post('/exams', { name: 'Test Exam', startDate: today })).data;
    await admin.put(`/exams/${exam.id}/papers`, { classId: classes[0].id, items: subjects.map((s: any) => ({ subjectId: s.id, maxMarks: 50, passMarks: 20 })) });
    const papers = (await admin.get(`/exams/${exam.id}/papers`)).data;
    const sec = (await admin.get('/sections')).data.find((s: any) => s.classId === classes[0].id);
    const sheet = (await admin.get(`/exam-papers/${papers[0].id}/marks?sectionId=${sec.id}`)).data;
    const ids = sheet.students.map((s: any) => s.studentId);
    const scores = [[50, 50], [45, 45], [45, 45], [10, 50]]; // 100%, 90%, 90% (tie), fail
    for (const [pi, p] of papers.entries()) {
      const entries = ids.map((sid: string, i: number) => ({ studentId: sid, marksObtained: scores[i]?.[pi] ?? 30 }));
      expect((await admin.put(`/exam-papers/${p.id}/marks`, { sectionId: sec.id, entries })).status).toBe(200);
    }
    expect((await admin.put(`/exam-papers/${papers[0].id}/marks`, { sectionId: sec.id, entries: [{ studentId: ids[0], marksObtained: 51 }] })).status).toBe(400);
    const res = (await admin.get(`/exams/${exam.id}/results?sectionId=${sec.id}`)).data;
    const r = (i: number) => res.results.find((x: any) => x.studentId === ids[i]);
    expect(r(0).percentage).toBe(100);
    expect(r(0).grade).toBe('A+');
    expect(r(0).rank).toBe(1);
    expect(r(1).rank).toBe(2);
    expect(r(2).rank).toBe(2);
    expect(r(3).passed).toBe(false); // failed one subject despite 60%
    expect(r(3).rank).toBeGreaterThan(r(ids.length - 1).rank ?? 0);
    expect((await admin.post(`/exams/${exam.id}/publish`, { publish: true })).status).toBe(200);
    expect((await admin.put(`/exam-papers/${papers[0].id}/marks`, { sectionId: sec.id, entries: [{ studentId: ids[0], marksObtained: 1 }] })).status).toBe(400);
  });
});

describe('reports', () => {
  it('lists, runs and exports reports with permission checks', async () => {
    const admin = client(await login('admin@alpha.test'));
    const list = (await admin.get('/reports')).data;
    expect(list.map((r: any) => r.key)).toContain('fee-pending');
    const run = await admin.post('/reports/attendance-summary/run', { params: { below: 100 } });
    expect(run.status).toBe(200);
    expect(run.data.columns.length).toBeGreaterThan(3);
    for (const format of ['csv', 'xlsx', 'pdf']) {
      const res = await admin.post('/reports/students/export', { format, params: {} });
      expect(res.status).toBe(200);
    }
    const parent = client(await login('parent@riverside.edu'));
    expect((await parent.post('/reports/fee-pending/run', { params: {} })).status).toBe(403);
    expect((await admin.post('/reports/nope/run', { params: {} })).status).toBe(400);
  });

  it('builds a dashboard for each role from live data', async () => {
    for (const [email, kind] of [
      ['admin@alpha.test', 'admin'],
      ['sneha.kulkarni@riverside.edu', 'teacher'],
      ['accounts@riverside.edu', 'accountant'],
      ['parent@riverside.edu', 'parent'],
      ['student@riverside.edu', 'student'],
    ] as const) {
      const d = await client(await login(email)).get('/dashboard');
      expect(d.status, email).toBe(200);
      expect(d.data.kind).toBe(kind);
    }
  });
});
