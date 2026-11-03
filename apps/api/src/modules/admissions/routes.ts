import { z } from 'zod';
import { ENQUIRY_STATUSES } from '@edumin/shared';
import { ctxOf, guard, idParam, ok, typed, type App } from '../../core/http';
import { requirePermission } from '../../core/context';
import {
  applicationInput,
  applicationListQuery,
  enquiryInput,
  enquiryListQuery,
  enrollApplication,
  getApplication,
  listApplications,
  listEnquiries,
  reviewApplication,
  submitApplication,
  submitEnquiry,
  updateEnquiry,
} from './service';

const F = { feature: 'admissions' as const };

export async function admissionRoutes(app: App) {
  const r = typed(app);

  r.get('/admissions/enquiries', { preValidation: guard('admissions.view', F), schema: { tags: ['Admissions'], querystring: enquiryListQuery } }, async (req) => {
    const { rows, total } = await listEnquiries(ctxOf(req), req.query);
    return ok(rows, { page: req.query.page, pageSize: req.query.pageSize, total });
  });

  r.post('/admissions/enquiries', { preValidation: guard('admissions.create', F), schema: { tags: ['Admissions'], body: enquiryInput.extend({ source: z.string().default('walk_in') }) } }, async (req) => {
    const ctx = ctxOf(req);
    return ok(await submitEnquiry(ctx.db, ctx.schoolId, req.body));
  });

  r.patch(
    '/admissions/enquiries/:id',
    { preValidation: guard('admissions.edit', F), schema: { tags: ['Admissions'], params: idParam, body: z.object({ status: z.enum(ENQUIRY_STATUSES), notes: z.string().nullish() }) } },
    async (req) => ok(await updateEnquiry(ctxOf(req), req.params.id, req.body)),
  );

  r.get('/admissions/applications', { preValidation: guard('admissions.view', F), schema: { tags: ['Admissions'], querystring: applicationListQuery } }, async (req) => {
    const { rows, total } = await listApplications(ctxOf(req), req.query);
    return ok(rows, { page: req.query.page, pageSize: req.query.pageSize, total });
  });

  r.post('/admissions/applications', { preValidation: guard('admissions.create', F), schema: { tags: ['Admissions'], body: applicationInput } }, async (req) => {
    const ctx = ctxOf(req);
    requirePermission(ctx, 'admissions.create');
    const row = await submitApplication(ctx.db, ctx.schoolId, req.body);
    return ok({ id: row.id, applicationNo: row.applicationNo });
  });

  r.get('/admissions/applications/:id', { preValidation: guard('admissions.view', F), schema: { tags: ['Admissions'], params: idParam } }, async (req) =>
    ok(await getApplication(ctxOf(req), req.params.id)),
  );

  r.post(
    '/admissions/applications/:id/review',
    {
      preValidation: guard(undefined, F),
      schema: { tags: ['Admissions'], params: idParam, body: z.object({ status: z.enum(['under_review', 'approved', 'rejected']), remarks: z.string().nullish() }) },
    },
    async (req) => ok(await reviewApplication(ctxOf(req), req.params.id, req.body)),
  );

  r.post(
    '/admissions/applications/:id/enroll',
    { preValidation: guard('admissions.approve', F), schema: { tags: ['Admissions'], params: idParam, body: z.object({ sectionId: z.uuid(), admissionNo: z.string().trim().nullish() }) } },
    async (req) => ok(await enrollApplication(ctxOf(req), req.params.id, req.body)),
  );
}

