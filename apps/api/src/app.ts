import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { env } from './core/env';
import { httpPlugin } from './core/http';
import { authRoutes } from './modules/auth/routes';
import { publicRoutes } from './modules/public/routes';
import { platformRoutes } from './modules/platform/routes';
import { settingsRoutes } from './modules/settings/routes';
import { userRoutes } from './modules/users/routes';
import { fileRoutes } from './modules/files/routes';
import { academicRoutes } from './modules/academics/routes';
import { studentRoutes } from './modules/students/routes';
import { admissionRoutes } from './modules/admissions/routes';
import { attendanceRoutes } from './modules/attendance/routes';
import { feeRoutes } from './modules/fees/routes';
import { examRoutes } from './modules/exams/routes';
import { timetableRoutes } from './modules/timetable/routes';
import { homeworkRoutes } from './modules/homework/routes';
import { communicationRoutes } from './modules/communication/routes';
import { meetingRoutes } from './modules/meetings/routes';
import { eventRoutes } from './modules/events/routes';
import { reportRoutes } from './modules/reports/routes';
import { dashboardRoutes } from './modules/dashboard/routes';

/** Feature modules, mounted under /api. Order is irrelevant. */
const modules = [authRoutes, publicRoutes, platformRoutes, settingsRoutes, userRoutes, fileRoutes, academicRoutes, studentRoutes, admissionRoutes, attendanceRoutes,
  feeRoutes,
  examRoutes,
  timetableRoutes,
  homeworkRoutes,
  communicationRoutes,
  meetingRoutes,
  eventRoutes,
  reportRoutes,
  dashboardRoutes,
];

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? (env.NODE_ENV === 'development' ? { level: 'info', transport: undefined } : false),
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, {
    credentials: true,
    origin: (origin, cb) => {
      // Allow the app origin and any school subdomain of the root domain.
      if (!origin) return cb(null, true);
      try {
        const host = new URL(origin).hostname;
        const appHost = new URL(env.APP_URL).hostname;
        cb(null, host === appHost || host === env.ROOT_DOMAIN || host.endsWith('.' + env.ROOT_DOMAIN) || host === 'localhost');
      } catch {
        cb(null, false);
      }
    },
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, { global: false });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Edumin School Management API',
        version: '0.1.0',
        description:
          'Multi-tenant school management API. All school endpoints are scoped to the authenticated user\'s school and checked against role permissions and data scope. Responses use the envelope `{ success, data, meta? }` or `{ success: false, error: { code, message, details } }`.',
      },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, cookie: { type: 'apiKey', in: 'cookie', name: 'edumin_token' } } },
      security: [{ bearer: [] }, { cookie: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  // Serve the built web app from the same origin when it exists (production).
  const webDist = path.resolve(env.WEB_DIST);
  const spaIndexHtml = existsSync(path.join(webDist, 'index.html')) ? readFileSync(path.join(webDist, 'index.html'), 'utf8') : null;
  if (spaIndexHtml) await app.register(fastifyStatic, { root: webDist, wildcard: false, index: false });
  await app.register(httpPlugin, { spaIndexHtml });

  app.get('/api/health', { schema: { hide: true } }, async () => ({ success: true, data: { status: 'ok', time: new Date().toISOString() } }));

  await app.register(
    async (api) => {
      for (const m of modules) await api.register(m);
    },
    { prefix: '/api' },
  );

  return app;
}
