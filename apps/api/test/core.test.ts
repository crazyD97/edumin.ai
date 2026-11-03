import { describe, expect, it, beforeAll } from 'vitest';
import { client, getApp, login } from './helpers';
import { formatNumber } from '../src/core/sequence';
import { installments } from '../src/modules/fees/service';
import { gradeFor } from '../src/modules/exams/service';
import { DEFAULT_GRADE_BANDS } from '../src/modules/platform/provision';

describe('pure helpers', () => {
  it('formats sequence numbers', () => {
    const d = new Date('2026-04-05');
    expect(formatNumber('ADM{YYYY}{SEQ:4}', 7, d)).toBe('ADM20260007');
    expect(formatNumber('R-{YY}{MM}-{SEQ}', 12, d)).toBe('R-2604-12');
  });
  it('builds installment schedules', () => {
    expect(installments('monthly', '2026-04-01', 10)).toHaveLength(12);
    expect(installments('quarterly', '2026-04-01', 10).map((i) => i.dueDate)).toEqual(['2026-04-10', '2026-07-10', '2026-10-10', '2027-01-10']);
    expect(installments('annual', '2026-04-01', 15)[0].dueDate).toBe('2026-04-15');
  });
  it('maps percentages to grades', () => {
    expect(gradeFor(91, DEFAULT_GRADE_BANDS)?.grade).toBe('A+');
    expect(gradeFor(33, DEFAULT_GRADE_BANDS)?.grade).toBe('E');
    expect(gradeFor(10, DEFAULT_GRADE_BANDS)?.grade).toBe('F');
    expect(gradeFor(null, DEFAULT_GRADE_BANDS)).toBeNull();
  });
});

describe('authentication', () => {
  it('rejects bad credentials and wrong tenant', async () => {
    const app = await getApp();
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@alpha.test', password: 'nope', schoolSlug: 'alpha' } });
    expect(bad.statusCode).toBe(401);
    const wrongSchool = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@alpha.test', password: 'Password@123', schoolSlug: 'beta' } });
    expect(wrongSchool.statusCode).toBe(401);
  });

  it('returns the session with permissions', async () => {
    const me = await client(await login('admin@alpha.test')).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.data.role.key).toBe('school_admin');
    expect(me.data.school.slug).toBe('alpha');
    expect(me.data.permissions).toContain('fees.approve');
  });

  it('requires auth for school endpoints', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/students' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('revokes tokens on password change', async () => {
    const token = await login('accounts@riverside.edu');
    const c = client(token);
    expect((await c.post('/auth/change-password', { currentPassword: 'Password@123', newPassword: 'NewPassword@1' })).status).toBe(200);
    expect((await c.get('/auth/me')).status).toBe(401);
    const fresh = client(await login('accounts@riverside.edu', 'NewPassword@1'));
    await fresh.post('/auth/change-password', { currentPassword: 'NewPassword@1', newPassword: 'Password@123' });
  });
});

describe('tenant isolation', () => {
  let alpha: ReturnType<typeof client>;
  let beta: ReturnType<typeof client>;
  beforeAll(async () => {
    alpha = client(await login('admin@alpha.test'));
    beta = client(await login('admin@beta.test', 'Password@123', 'beta'));
  });

  it('never lists another school’s students', async () => {
    const a = await alpha.get('/students?pageSize=500');
    const b = await beta.get('/students?pageSize=500');
    const aIds = new Set(a.data.map((s: any) => s.id));
    expect(b.data.some((s: any) => aIds.has(s.id))).toBe(false);
  });

  it('returns 404/403 when addressing another school’s records directly', async () => {
    const a = await alpha.get('/students?pageSize=1');
    const id = a.data[0].id;
    expect((await beta.get(`/students/${id}`)).status).toBeGreaterThanOrEqual(403);
    expect((await beta.put(`/students/${id}`, { firstName: 'Hacked', guardians: [] })).status).toBeGreaterThanOrEqual(403);
    expect((await beta.get(`/fees/students/${id}/ledger`)).status).toBeGreaterThanOrEqual(403);
    const sections = await alpha.get('/sections');
    expect((await beta.get(`/attendance/sheet?sectionId=${sections.data[0].id}&date=2026-01-05`)).status).toBeGreaterThanOrEqual(403);
  });

  it('enforces plan features', async () => {
    const res = await beta.get('/fees/heads');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/not enabled/);
  });

  it('blocks suspended schools', async () => {
    const root = client(await login('root@test.dev', 'Root@1234', null));
    const list = await root.get('/platform/schools?search=beta');
    const betaId = list.data[0].id;
    await root.patch(`/platform/schools/${betaId}`, { status: 'suspended' });
    const res = await beta.get('/students');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SCHOOL_SUSPENDED');
    await root.patch(`/platform/schools/${betaId}`, { status: 'active' });
    expect((await beta.get('/students')).status).toBe(200);
  });

  it('keeps platform endpoints away from school users', async () => {
    expect((await alpha.get('/platform/stats')).status).toBe(403);
  });
});
