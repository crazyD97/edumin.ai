# Edumin — Multi-tenant School Management SaaS

One platform, many schools. Each school gets its own branding, users, settings and completely isolated data. Edumin covers admissions, students, classes, attendance, fees, examinations, timetables, homework, communication, meetings, a school calendar, reports and role-based dashboards, plus a super-admin console for the SaaS owner.

For the Indian market it adds WhatsApp/SMS/email alerts paid for with message credits, Razorpay fee collection into each school's own account (including pay links that work without logging in), certificates with QR verification, printable ID cards, an installable parent app (PWA) with push notifications, a setup checklist for new schools and Ctrl+K search.

| | |
|---|---|
| **Backend** | Node.js · Fastify 5 · TypeScript · Drizzle ORM · PostgreSQL · Zod (validation + OpenAPI) |
| **Frontend** | React 19 · Vite · Tailwind CSS 4 · TanStack Query · React Router · Recharts |
| **Docs** | [Architecture](docs/ARCHITECTURE.md) · [Implementation checklist](docs/CHECKLIST.md) · [Messaging, payments & PWA](docs/MESSAGING.md) · [MCP / LLM readiness](docs/MCP.md) · [Deployment](docs/DEPLOYMENT.md) |

## Quick start

Requirements: Node 22+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env
```

Start a database. Pick one:

```bash
npm run db:start            # project-local cluster on :5433 using your installed PostgreSQL binaries
docker compose up -d db     # or a container on :5433
```

Then migrate, seed demo data and run both apps:

```bash
npm run db:seed             # applies migrations and loads two demo schools
npm run dev                 # API on :4000, web on :5173
```

Open **http://localhost:5173**. The login page has one-click demo accounts in development.

| Role | Email | Password | School code |
|---|---|---|---|
| Platform super admin | admin@edumin.app | Admin@123 | *(none — use “Platform admin”)* |
| School admin | admin@greenwood.edu | Password@123 | greenwood |
| Principal | principal@greenwood.edu | Password@123 | greenwood |
| Teacher | priya.nair@greenwood.edu | Password@123 | greenwood |
| Accountant | accounts@greenwood.edu | Password@123 | greenwood |
| Parent | parent@greenwood.edu *or* 9876543210 | Password@123 | greenwood |
| Student | student@greenwood.edu | Password@123 | greenwood |
| Second tenant (trial) | admin@riverside.edu | Password@123 | riverside |

**School subdomains** work out of the box in Chrome/Edge: open `http://greenwood.edumin.localhost:5173` and the login page is already branded for Greenwood — no school code needed.

Messaging runs against simulators until provider keys are set, so WhatsApp/SMS alerts appear in **WhatsApp & SMS → Delivery log** without sending anything. Greenwood is seeded with 5,000 credits.

API docs (OpenAPI / Swagger UI): **http://localhost:4000/api/docs**

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API (watch mode) + web dev server |
| `npm test` | API integration tests against `edumin_test` (rebuilt each run) |
| `npm run typecheck` | Type-check all workspaces |
| `npm run build` | Production build (API bundle + static web app) |
| `npm run db:generate` | Generate a migration after editing `apps/api/src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | **Reset** the dev database and load demo data |

## Repository layout

```
apps/
  api/                 Fastify API (modular monolith)
    src/core/          auth, tenant context, permissions, errors, PDF/export, storage, notifications
    src/modules/<m>/   one folder per module: routes.ts (HTTP) + service.ts (business logic)
    src/db/            schema, migrations runner, demo seed
    drizzle/           SQL migrations
    test/              integration tests
  web/                 React SPA
    src/components/    shared UI kit (buttons, tables, modals, charts, forms)
    src/pages/<m>/     screens per module
packages/
  shared/              permissions, roles, enums and API types shared by both apps
docs/                  architecture, checklist, MCP readiness, deployment
```
