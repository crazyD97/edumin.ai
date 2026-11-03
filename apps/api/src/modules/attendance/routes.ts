import { z } from 'zod';
import { LEAVE_STATUSES } from '@edumin/shared';
import { ctxOf, guard, idParam, ok, typed, type App } from '../../core/http';
import {
  applyLeave,
  attendanceStats,
  getSheet,
  leaveInput,
  listLeave,
  lowAttendance,
  markAttendance,
  markInput,
  markStaff,
  monthlyRegister,
  reviewLeave,
  sendLowAttendanceAlerts,
  staffMarkInput,
  staffSheet,
  studentAttendance,
} from './service';

const F = { feature: 'attendance' as const };
const range = z.object({ from: z.iso.date(), to: z.iso.date() });

export async function attendanceRoutes(app: App) {
  const r = typed(app);

  r.get('/attendance/sheet', { preValidation: guard('attendance.view', F), schema: { tags: ['Attendance'], querystring: z.object({ sectionId: z.uuid(), date: z.iso.date() }) } }, async (req) =>
    ok(await getSheet(ctxOf(req), req.query.sectionId, req.query.date)),
  );

  r.post('/attendance/mark', { preValidation: guard('attendance.create', F), schema: { tags: ['Attendance'], summary: 'Bulk mark a whole section for one day', body: markInput } }, async (req) =>
    ok(await markAttendance(ctxOf(req), req.body)),
  );

  r.get(
    '/attendance/register',
    { preValidation: guard('attendance.view', F), schema: { tags: ['Attendance'], querystring: z.object({ sectionId: z.uuid(), month: z.string().regex(/^\d{4}-\d{2}$/) }) } },
    async (req) => ok(await monthlyRegister(ctxOf(req), req.query.sectionId, req.query.month)),
  );

  r.get(
    '/attendance/summary',
    { preValidation: guard('attendance.view', F), schema: { tags: ['Attendance'], querystring: range.extend({ sectionId: z.uuid().optional(), classId: z.uuid().optional() }) } },
    async (req) => ok(await attendanceStats(ctxOf(req), req.query)),
  );

  r.get('/attendance/students/:id', { preValidation: guard('attendance.view', F), schema: { tags: ['Attendance'], params: idParam, querystring: range } }, async (req) =>
    ok(await studentAttendance(ctxOf(req), req.params.id, req.query.from, req.query.to)),
  );

  r.get(
    '/attendance/low',
    { preValidation: guard('attendance.view', F), schema: { tags: ['Attendance'], querystring: range.extend({ threshold: z.coerce.number().min(0).max(100).optional(), sectionId: z.uuid().optional(), classId: z.uuid().optional() }) } },
    async (req) => ok(await lowAttendance(ctxOf(req), req.query)),
  );

  r.post(
    '/attendance/low/alerts',
    { preValidation: guard('attendance.edit', F), schema: { tags: ['Attendance'], body: range.extend({ threshold: z.coerce.number().min(0).max(100).optional(), sectionId: z.uuid().nullish() }) } },
    async (req) => ok(await sendLowAttendanceAlerts(ctxOf(req), req.body)),
  );

  r.get('/attendance/staff', { preValidation: guard('staff.view', F), schema: { tags: ['Attendance'], querystring: z.object({ date: z.iso.date() }) } }, async (req) =>
    ok(await staffSheet(ctxOf(req), req.query.date)),
  );
  r.post('/attendance/staff', { preValidation: guard('staff.edit', F), schema: { tags: ['Attendance'], body: staffMarkInput } }, async (req) => ok(await markStaff(ctxOf(req), req.body)));

  r.get(
    '/leave',
    { preValidation: guard('leave.view'), schema: { tags: ['Leave'], querystring: z.object({ status: z.enum(LEAVE_STATUSES).optional(), mine: z.enum(['true', 'false']).optional() }) } },
    async (req) => ok(await listLeave(ctxOf(req), { status: req.query.status, mine: req.query.mine === 'true' })),
  );
  r.post('/leave', { preValidation: guard('leave.create'), schema: { tags: ['Leave'], body: leaveInput } }, async (req) => ok(await applyLeave(ctxOf(req), req.body)));
  r.post(
    '/leave/:id/review',
    { preValidation: guard(), schema: { tags: ['Leave'], params: idParam, body: z.object({ status: z.enum(['approved', 'rejected', 'cancelled']), note: z.string().nullish() }) } },
    async (req) => ok(await reviewLeave(ctxOf(req), req.params.id, req.body)),
  );
}
