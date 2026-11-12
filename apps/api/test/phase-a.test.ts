import { describe, expect, it, beforeAll } from 'vitest';
import { client, getApp, login } from './helpers';
import { normalizeIndianMobile } from '@edumin/shared';
import { hmacHex, encryptJson, decryptJson, signLink, verifyLink } from '../src/core/crypto';
import { verifyPaymentSignature, verifyWebhookSignature } from '../src/core/razorpay';
import { dateInWords } from '../src/modules/certificates/service';
import { renderTemplate } from '../src/modules/messaging/templates';
import { deliverQueued } from '../src/modules/messaging/service';

type C = ReturnType<typeof client>;

describe('helpers', () => {
  it('normalises Indian mobile numbers', () => {
    expect(normalizeIndianMobile('98765 43210')).toBe('919876543210');
    expect(normalizeIndianMobile('+91-98765-43210')).toBe('919876543210');
    expect(normalizeIndianMobile('098765 43210')).toBe('919876543210');
    expect(normalizeIndianMobile('12345')).toBeNull();
    expect(normalizeIndianMobile('5876543210')).toBeNull(); // Indian mobiles start 6–9
  });
  it('encrypts secrets and signs links', () => {
    const enc = encryptJson({ keySecret: 's3cret' });
    expect(enc).not.toContain('s3cret');
    expect(decryptJson(enc)).toEqual({ keySecret: 's3cret' });
    expect(decryptJson(enc.slice(0, -4) + 'AAAA')).toBeNull(); // tampered
    const { exp, sig } = signLink('pay:abc');
    expect(verifyLink('pay:abc', exp, sig)).toBe(true);
    expect(verifyLink('pay:xyz', exp, sig)).toBe(false);
    expect(verifyLink('pay:abc', Math.floor(Date.now() / 1000) - 1, sig)).toBe(false);
  });
  it('verifies Razorpay signatures', () => {
    const secret = 'rzp_secret';
    expect(verifyPaymentSignature(secret, 'order_1', 'pay_1', hmacHex(secret, 'order_1|pay_1'))).toBe(true);
    expect(verifyPaymentSignature(secret, 'order_1', 'pay_2', hmacHex(secret, 'order_1|pay_1'))).toBe(false);
    const body = '{"event":"payment.captured"}';
    expect(verifyWebhookSignature('wh', body, hmacHex('wh', body))).toBe(true);
  });
  it('writes dates in words and renders templates', () => {
    expect(dateInWords('2011-02-11')).toBe('Eleventh February Two Thousand Eleven');
    expect(dateInWords('2015-03-21')).toBe('Twenty-First March Two Thousand Fifteen');
    const t = renderTemplate('attendance_absent', { school: 'Alpha', student: 'Ria\nSen', date: '5 Jan' });
    expect(t.params).toEqual(['Alpha', 'Ria Sen', '5 Jan']); // newlines are not allowed in WhatsApp params
    expect(t.text).toContain('Ria Sen was marked absent at Alpha on 5 Jan');
  });
});

describe('messaging & credits', () => {
  let admin: C;
  beforeAll(async () => {
    admin = client(await login('admin@alpha.test'));
  });

  it('sends absence alerts on enabled channels and charges credits', async () => {
    const o = (await admin.get('/messaging')).data;
    await admin.put('/messaging/settings', { ...o.settings, channels: { email: true, whatsapp: true, sms: false } });
    const order = (await admin.post('/messaging/credits/orders', { packKey: 'starter_1k' })).data;
    expect(order.gateway).toBe('mock');
    expect((await admin.post(`/messaging/credits/orders/${order.orderId}/mock-pay`)).data.balance).toBe(1000);
    expect((await admin.post(`/messaging/credits/orders/${order.orderId}/mock-pay`)).status).toBe(409);

    const sec = (await admin.get('/sections')).data[0];
    const date = new Date(Date.now() - 86400_000 * 500).toISOString().slice(0, 10); // outside the seeded attendance range
    const sheet = (await admin.get(`/attendance/sheet?sectionId=${sec.id}&date=${date}`)).data;
    const records = sheet.students.map((s: any, i: number) => ({ studentId: s.studentId, status: i === 0 ? 'absent' : 'present' }));
    await admin.post('/attendance/mark', { sectionId: sec.id, date, records });
    const log = (await admin.get('/messaging/log?event=attendance_absent')).data;
    expect(log.some((m: any) => m.channel === 'whatsapp' && m.recipient.startsWith('91'))).toBe(true);
    expect((await admin.get('/messaging')).data.credits).toBe(999);

    // Re-saving the same attendance does not alert again.
    await admin.post('/attendance/mark', { sectionId: sec.id, date, records });
    expect((await admin.get('/messaging')).data.credits).toBe(999);

    await deliverQueued();
    const delivered = (await admin.get('/messaging/log?event=attendance_absent')).data;
    expect(delivered.every((m: any) => m.status === 'delivered')).toBe(true);
  });

  it('skips paid channels when credits run out', async () => {
    const root = client(await login('root@test.dev', 'Root@1234', null));
    const alphaId = (await root.get('/platform/schools?search=alpha')).data[0].id;
    const bal = (await admin.get('/messaging')).data.credits;
    expect((await root.post(`/platform/schools/${alphaId}/credits`, { credits: -(bal + 1) })).status).toBe(409); // never negative
    await root.post(`/platform/schools/${alphaId}/credits`, { credits: -bal, note: 'test drain' });
    const res = await admin.post('/messaging/test', { channel: 'whatsapp', to: '9876512345' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/credits/i);
    await root.post(`/platform/schools/${alphaId}/credits`, { credits: 100 });
  });

  it('enforces plan features and permissions', async () => {
    const beta = client(await login('admin@beta.test', 'Password@123', 'beta'));
    const s = (await beta.get('/messaging')).data;
    expect(s.featureEnabled).toBe(false);
    expect((await beta.put('/messaging/settings', { ...s.settings, channels: { email: true, whatsapp: true, sms: false } })).status).toBe(403);
    const teacher = client(await login('sneha.kulkarni@riverside.edu'));
    expect((await teacher.get('/messaging')).status).toBe(403);
  });
});

describe('online fees', () => {
  it('pays through a signed public link and rejects tampered links', async () => {
    const admin = client(await login('admin@alpha.test'));
    const student = (await admin.get('/students?pageSize=3')).data[2];
    const head = (await admin.get('/fees/heads')).data[0];
    await admin.post('/fees/structures', { feeHeadId: head.id, studentId: student.id, name: 'Activity fee', amount: 700, frequency: 'one_time' });
    await admin.post('/fees/generate', {});
    const { payLink } = await import('../src/modules/fees/service');
    const url = new URL(payLink(student.id));
    const qs = url.search;
    const app = await getApp();
    const info = (await app.inject({ url: `/api/public/pay/${student.id}${qs}` })).json().data;
    const inv = info.invoices.find((i: any) => i.title === 'Activity fee');
    expect(inv.balance).toBe(700);
    const bad = await app.inject({ url: `/api/public/pay/${student.id}${qs.replace(/sig=./, 'sig=0')}` });
    expect(bad.statusCode).toBe(403);
    const order = (await app.inject({ method: 'POST', url: `/api/public/pay/${student.id}/order${qs}`, payload: { invoiceIds: [inv.id] } })).json().data;
    expect(order.amount).toBe(700);
    const paid = (await app.inject({ method: 'POST', url: `/api/public/pay/${student.id}/mock-complete${qs}`, payload: { paymentId: order.paymentId, success: true } })).json().data;
    expect(paid.status).toBe('completed');
    const ledger = (await admin.get(`/fees/students/${student.id}/ledger`)).data;
    expect(ledger.invoices.find((i: any) => i.id === inv.id).status).toBe('paid');
  });

  it('stores Razorpay keys encrypted and never returns the secret', async () => {
    const admin = client(await login('admin@alpha.test'));
    const res = await admin.put('/integrations/razorpay', { enabled: false, keyId: 'rzp_test_Abc123', keySecret: 'very-secret-value' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('very-secret-value');
    expect(res.data[0].hasKeySecret).toBe(true);
    expect((await admin.put('/integrations/razorpay', { enabled: false, keyId: 'not-a-key' })).status).toBe(400);
  });
});

describe('certificates & ID cards', () => {
  it('issues a TC with a serial and QR verification, then revokes it', async () => {
    const admin = client(await login('admin@alpha.test'));
    const s = (await admin.get('/students?pageSize=5')).data[4];
    const fields = (await admin.get(`/students/${s.id}/certificates/defaults?type=transfer`)).data;
    expect(fields.lastClass).toBeTruthy();
    const c = (await admin.post(`/students/${s.id}/certificates`, { type: 'transfer', fields, markTransferred: true })).data;
    expect(c.serialNo).toMatch(/^TC\/\d{4}\/0001$/);
    expect((await admin.get(`/students/${s.id}`)).data.status).toBe('transferred');
    const pdf = await admin.get(`/certificates/${c.id}/pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const app = await getApp();
    expect((await app.inject({ url: `/api/public/verify/certificate/${c.id}` })).json().data.valid).toBe(true);
    await admin.post(`/certificates/${c.id}/revoke`, { reason: 'Wrong date' });
    expect((await app.inject({ url: `/api/public/verify/certificate/${c.id}` })).json().data.valid).toBe(false);
    const cards = await admin.get(`/id-cards/students?sectionId=${(await admin.get('/sections')).data[0].id}`);
    expect(cards.status).toBe(200);
  });
});

describe('onboarding, search & mobile login', () => {
  it('sets up classes in one call and reports progress', async () => {
    const admin = client(await login('admin@alpha.test'));
    const before = (await admin.get('/setup/status')).data;
    const res = await admin.post('/setup/classes', { classes: ['Nursery', 'LKG'], sections: ['Rose', 'Lily'], subjects: ['Rhymes'] });
    expect(res.data).toEqual({ classes: 2, sections: 4, subjects: 1 });
    expect((await admin.post('/setup/classes', { classes: ['Nursery'], sections: ['Rose'], subjects: [] })).data.sections).toBe(0); // idempotent
    expect((await admin.get('/setup/status')).data.total).toBe(before.total);
  });

  it('creates parent logins in bulk; parents sign in with their mobile number', async () => {
    const admin = client(await login('admin@alpha.test'));
    const preview = (await admin.post('/guardians/portal-accounts/bulk', { dryRun: true })).data;
    expect(preview.eligible).toBeGreaterThan(0);
    const res = (await admin.post('/guardians/portal-accounts/bulk', {})).data;
    expect(res.created).toBe(preview.eligible);
    expect(res.slipsPdf.length).toBeGreaterThan(1000);
    expect((await admin.post('/guardians/portal-accounts/bulk', { dryRun: true })).data.eligible).toBe(0);
  });

  it('logs in with a mobile number in any format', async () => {
    const app = await getApp();
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: '+91 98765-01234', password: 'Password@123', schoolSlug: 'alpha' } });
    expect(r.statusCode).toBe(200);
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: '9876501234', password: 'nope', schoolSlug: 'alpha' } });
    expect(wrong.statusCode).toBe(401);
  });

  it('limits global search to what the caller may see', async () => {
    const admin = client(await login('admin@alpha.test'));
    const parent = client(await login('parent@riverside.edu'));
    const own = (await parent.get('/students/mine')).data[0];
    const someoneElse = (await admin.get('/students?pageSize=10')).data.find((s: any) => s.id !== own.id);
    expect((await admin.get(`/search?q=${encodeURIComponent(someoneElse.firstName)}`)).data.length).toBeGreaterThan(0);
    const groups = (await parent.get(`/search?q=${encodeURIComponent(someoneElse.firstName)}`)).data;
    const ids = groups.flatMap((g: any) => g.items.map((i: any) => i.id));
    expect(ids.every((id: string) => id === own.id)).toBe(true);
    expect(groups.some((g: any) => g.type === 'staff' || g.type === 'receipt')).toBe(false);
  });
});
