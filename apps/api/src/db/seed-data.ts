/** Realistic demo data for one school. Used by the seed and by tests. */
import { and, eq } from 'drizzle-orm';
import { db } from '../core/db';
import { hashPassword } from '../core/auth';
import {
  academicYears,
  classes,
  enrollments,
  guardians,
  roles,
  sectionSubjects,
  sections,
  staffProfiles,
  studentGuardians,
  students,
  subjects,
  users,
} from './schema';
import { academicYearFor } from '../modules/platform/provision';
import { seedActivity } from './seed-activity';

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Ayaan', 'Krishna', 'Ishaan', 'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Myra', 'Aanya', 'Pari', 'Anika', 'Navya', 'Kiara', 'Rohan', 'Kabir', 'Meera', 'Zara', 'Tara', 'Neel', 'Riya', 'Dev', 'Isha', 'Om'];
const LAST = ['Sharma', 'Verma', 'Iyer', 'Nair', 'Reddy', 'Gupta', 'Patel', 'Rao', 'Menon', 'Kapoor', 'Singh', 'Joshi', 'Das', 'Pillai', 'Bose', 'Mehta'];
const pick = <T>(arr: T[], i: number) => arr[i % arr.length];

export async function seedSchoolData(schoolId: string, opts: { size: 'small' | 'large' }) {
  const large = opts.size === 'large';
  const pw = await hashPassword('Password@123');
  const domain = large ? 'greenwood.edu' : 'riverside.edu';
  const roleRows = await db.select().from(roles).where(eq(roles.schoolId, schoolId));
  const role = (k: string) => roleRows.find((r) => r.key === k)!.id;

  // ── Years: previous (history) + current (created by provisioning) ──
  const [current] = await db.select().from(academicYears).where(and(eq(academicYears.schoolId, schoolId), eq(academicYears.isCurrent, true)));
  const prevDates = academicYearFor(new Date(new Date(current.startDate).getTime() - 200 * 86400_000));
  const [previous] = await db.insert(academicYears).values({ schoolId, ...prevDates, isCurrent: false }).returning();

  // ── Staff ──
  const teacherNames = large
    ? ['Priya Nair', 'Rajesh Kumar', 'Sunita Rao', 'Arvind Iyer', 'Kavita Menon', 'Farhan Ali', 'Deepa Pillai', 'Manoj Gupta', 'Lakshmi Reddy', 'Vikram Joshi']
    : ['Sneha Kulkarni', 'Arjun Bhat', 'Neha Shah'];
  const teachers = await db
    .insert(users)
    .values(
      teacherNames.map((n) => ({
        schoolId,
        roleId: role('teacher'),
        email: `${n.toLowerCase().replace(' ', '.')}@${domain}`,
        fullName: n,
        phone: '98450' + String(Math.floor(Math.random() * 1e5)).padStart(5, '0'),
        passwordHash: pw,
      })),
    )
    .returning();
  await db.insert(staffProfiles).values(
    teachers.map((t, i) => ({ userId: t.id, schoolId, employeeCode: `EMP${String(i + 1).padStart(3, '0')}`, designation: i === 0 ? 'Senior Teacher' : 'Teacher', department: 'Academics', joinDate: '2019-06-01' })),
  );
  const others = await db
    .insert(users)
    .values([
      { schoolId, roleId: role('accountant'), email: `accounts@${domain}`, fullName: 'Suresh Pai', passwordHash: pw },
      { schoolId, roleId: role('principal'), email: `principal@${domain}`, fullName: large ? 'Dr. Meera Iyer' : 'Mr. Thomas George', passwordHash: pw },
    ])
    .returning();
  await db.insert(staffProfiles).values(others.map((u, i) => ({ userId: u.id, schoolId, employeeCode: `EMP${100 + i}`, designation: i === 0 ? 'Accountant' : 'Principal', department: 'Administration' })));

  // ── Classes, subjects, sections (both years) ──
  const classCount = large ? 10 : 5;
  const classRows = await db
    .insert(classes)
    .values(Array.from({ length: classCount }, (_, i) => ({ schoolId, name: `Grade ${i + 1}`, level: i + 1 })))
    .returning();
  const subjectRows = await db
    .insert(subjects)
    .values(
      [
        ['English', 'ENG'],
        ['Mathematics', 'MAT'],
        ['Science', 'SCI'],
        ['Social Studies', 'SST'],
        ['Hindi', 'HIN'],
        ['Computer Science', 'CS'],
      ].map(([name, code]) => ({ schoolId, name, code })),
    )
    .returning();
  const sectionNames = large ? ['A', 'B'] : ['A'];
  const makeSections = async (yearId: string) => {
    const rows = await db
      .insert(sections)
      .values(
        classRows.flatMap((c, ci) =>
          sectionNames.map((s, si) => ({ schoolId, academicYearId: yearId, classId: c.id, name: s, classTeacherId: teachers[(ci * sectionNames.length + si) % teachers.length].id, capacity: 40, room: `${100 + ci * 10 + si}` })),
        ),
      )
      .returning();
    await db.insert(sectionSubjects).values(
      rows.flatMap((sec, i) => subjectRows.map((sub, j) => ({ schoolId, sectionId: sec.id, subjectId: sub.id, teacherId: teachers[(i + j) % teachers.length].id }))),
    );
    return rows;
  };
  const prevSections = await makeSections(previous.id);
  const curSections = await makeSections(current.id);
  const secOf = (list: typeof curSections, classId: string, name: string) => list.find((s) => s.classId === classId && s.name === name);

  // ── Students & guardians, with last-year history for everyone above Grade 1 ──
  const perSection = large ? 14 : 8;
  let n = 0;
  const allStudents: { id: string; sectionId: string }[] = [];
  for (const c of classRows) {
    for (const sName of sectionNames) {
      for (let k = 0; k < perSection; k++) {
        n++;
        const first = pick(FIRST, n * 7 + k);
        const last = pick(LAST, n * 3 + c.level);
        const gender = FIRST.indexOf(first) >= 10 && FIRST.indexOf(first) < 20 ? 'female' : FIRST.indexOf(first) % 2 ? 'male' : 'female';
        const birthYear = new Date().getFullYear() - 5 - c.level;
        const [s] = await db
          .insert(students)
          .values({
            schoolId,
            admissionNo: `ADM${birthYear + 5}${String(n).padStart(4, '0')}`,
            firstName: first,
            lastName: last,
            gender,
            dateOfBirth: `${birthYear}-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 27) + 1).padStart(2, '0')}`,
            phone: '9' + String(800000000 + n * 1371).slice(0, 9),
            address: `${n} MG Road, Bengaluru`,
            bloodGroup: pick(['A+', 'B+', 'O+', 'AB+', 'O-'], n),
            admissionDate: c.level > 1 ? previous.startDate : current.startDate,
          })
          .returning();
        const [g] = await db
          .insert(guardians)
          .values({ schoolId, name: `${pick(['Rakesh', 'Sanjay', 'Anil', 'Prakash', 'Mahesh', 'Ramesh'], n)} ${last}`, relation: 'father', phone: '9' + String(700000000 + n * 977).slice(0, 9), email: `parent${n}@example.com`, occupation: pick(['Engineer', 'Doctor', 'Business', 'Teacher', 'Banker'], n) })
          .returning();
        await db.insert(studentGuardians).values({ studentId: s.id, guardianId: g.id, isPrimary: true });
        const cur = secOf(curSections, c.id, sName)!;
        await db.insert(enrollments).values({ schoolId, studentId: s.id, academicYearId: current.id, sectionId: cur.id, rollNo: k + 1 });
        if (c.level > 1) {
          const prevClass = classRows.find((x) => x.level === c.level - 1)!;
          const prev = secOf(prevSections, prevClass.id, sName)!;
          await db.insert(enrollments).values({ schoolId, studentId: s.id, academicYearId: previous.id, sectionId: prev.id, rollNo: k + 1, status: 'promoted' });
        }
        allStudents.push({ id: s.id, sectionId: cur.id });
      }
    }
  }

  // ── Demo portal accounts: first student of the top class + their parent ──
  const demoStudent = allStudents[allStudents.length - perSection * sectionNames.length];
  const [stuUser] = await db.insert(users).values({ schoolId, roleId: role('student'), email: `student@${domain}`, fullName: 'Demo Student', passwordHash: pw }).returning();
  const [parUser] = await db.insert(users).values({ schoolId, roleId: role('parent'), email: `parent@${domain}`, fullName: 'Demo Parent', passwordHash: pw }).returning();
  const [st] = await db.update(students).set({ userId: stuUser.id }).where(eq(students.id, demoStudent.id)).returning();
  await db.update(users).set({ fullName: `${st.firstName} ${st.lastName}` }).where(eq(users.id, stuUser.id));
  const [link] = await db.select().from(studentGuardians).where(eq(studentGuardians.studentId, demoStudent.id));
  const [gd] = await db.update(guardians).set({ userId: parUser.id, email: `parent@${domain}` }).where(eq(guardians.id, link.guardianId)).returning();
  await db.update(users).set({ fullName: gd.name }).where(eq(users.id, parUser.id));

  await seedActivity({
    schoolId,
    large,
    current,
    previous,
    teachers,
    adminIds: others.map((o) => o.id),
    classRows,
    subjectRows,
    curSections,
    prevSections,
    students: allStudents,
    demo: { studentId: demoStudent.id, sectionId: demoStudent.sectionId, parentUserId: parUser.id, studentUserId: stuUser.id },
  });
}
