# LLM / MCP readiness

No chatbot ships in the MVP. The application is structured so that an MCP server can be added later as **one more adapter** over the existing services, alongside the HTTP routes, without architectural changes.

## Principles already in place

| Requirement | How it's met |
|---|---|
| API-first, centralised business logic | Routes are thin. All rules live in `modules/*/service.ts` functions that take a `Ctx`. |
| Tenant-aware permissions | A `Ctx` carries `schoolId`, permissions and data scope. Every service enforces them, whoever the caller is. |
| Standardised reporting | `modules/reports/registry.ts`: each report has a key, description, **Zod parameter schema**, required permission and feature, and returns a uniform `ReportResult` `{ title, columns, rows, summary, chart }`. |
| Consistent responses | One envelope and stable error codes (`FORBIDDEN`, `VALIDATION_ERROR`, `NOT_FOUND`…). |
| OpenAPI | Generated from the same Zod schemas at `/api/docs/json`. |
| Historical data | Enrollments per academic year; results computed from stored marks; payments and attendance kept indefinitely. |
| **No direct DB access for an LLM** | Tools call service functions only. There is no endpoint that accepts SQL or arbitrary filters. |

## How an MCP server would plug in

```ts
// apps/mcp/src/server.ts (future)
import { reports, runReport } from '@edumin/api/modules/reports/registry';
import { createCtx } from '@edumin/api/core/context';

// 1. Authenticate the MCP session the same way the web app does (user token) and build a Ctx.
const ctx = createCtx({ userId, schoolId, roleKey, scope, permissions, features });

// 2. Expose each report the user is allowed to run as a tool.
for (const r of availableReports(ctx)) {
  server.tool(`report_${r.key}`, r.description, z.toJSONSchema(r.params), (args) => runReport(ctx, r.key, args));
}

// 3. Expose selected services as action tools (with the same permission checks), e.g.
server.tool('generate_report_pdf', …, ({ key, params }) => exportReport(await runReport(ctx, key, params), 'pdf', ctx.schoolId));
```

Because the tools run with the user's own `Ctx`, a teacher's assistant can only see that teacher's classes, and a parent's only their children. This is the same guarantee the web UI gets.

## Example questions → tools

| Natural-language request | Tool call |
|---|---|
| "Show Class 10 results from 2019" | `report_exam-results { examId }` (exam resolved via `listExams(academicYearId)`), or `report_exam-compare-years { classId }` |
| "Compare attendance between 2023 and 2024" | `report_attendance-compare-years { academicYearIds: [...] }` |
| "Students with attendance below 75%" | `report_attendance-summary { below: 75, from, to }` |
| "Fee collection for March" | `report_fee-collection { from: '2026-03-01', to: '2026-03-31' }` |
| "List students with pending fees" | `report_fee-pending { overdueOnly: true }` |
| "Compare exam results across academic years" | `report_exam-compare-years` / `report_academic-year-comparison` |
| "Generate a PDF report for Class 10" | `export_report { key: 'exam-results', params: { examId, classId }, format: 'pdf' }` |

## Adding a new report

Add one `define({ key, name, description, category, permission, feature, params, run })` entry to `registry.ts`. It then appears automatically in the Reports screen (with a generated filter form), can be exported to PDF, Excel and CSV, and is ready to become an MCP tool.
