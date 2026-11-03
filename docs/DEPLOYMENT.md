# Deployment

## Single container

The production image runs one Node process. It serves the API at `/api/*` and the built web app for every other path, so there is no CORS and only one origin.

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

The container applies migrations on start (`node dist/db/migrate.js`), then runs `node dist/server.js`.

## Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✓ | — | PostgreSQL 14+ |
| `JWT_SECRET` | ✓ | — | ≥ 32 random bytes. The process refuses to start in production without it. |
| `APP_URL` | | `http://localhost:5173` | Used in email links and CORS |
| `ROOT_DOMAIN` | | `edumin.localhost` | Schools are served at `<slug>.<ROOT_DOMAIN>` |
| `PORT` | | `4000` | |
| `UPLOAD_DIR` | | `./uploads` | Mount a persistent volume, or swap the storage driver for S3 |
| `EMAIL_DRIVER` | | `console` | `console`, `smtp` (wire up a provider in `core/notify.ts`) or `none` |
| `PAYMENT_GATEWAY` | | `mock` | Implement `PaymentGateway` for Razorpay/Stripe |
| `WEB_DIST` | | `../web/dist` | Built SPA to serve |

The web app reads `VITE_ROOT_DOMAIN` at build time (default `edumin.localhost`).

## Subdomains

Point a wildcard DNS record `*.yourdomain.com` at the server and set `ROOT_DOMAIN=yourdomain.com`. The login page resolves the school from the host name, so `greenwood.yourdomain.com` shows Greenwood's branding. Use a wildcard TLS certificate at the reverse proxy (Caddy, Nginx, a cloud load balancer). The API sets `trustProxy`.

## Security checklist

- [x] Passwords hashed with bcrypt; JWT in an httpOnly, SameSite=Lax cookie (Secure in production); token version bump revokes all sessions on password change, deactivation or admin reset
- [x] Rate limiting on login and public admission endpoints
- [x] Helmet security headers; CORS restricted to the app origin and school subdomains
- [x] All input validated with Zod; field-level errors; 2 MB JSON body limit, 10 MB uploads with a MIME allow-list
- [x] Tenant isolation, permission and scope checks in services, covered by integration tests
- [x] Auth checked before validation (no schema disclosure to unauthorised callers)
- [x] Private files streamed only after school and entity access checks; SVGs served with a restrictive CSP
- [x] Audit log of important actions
- [ ] Before go-live: enable HTTPS, rotate `JWT_SECRET`, configure SMTP, set up DB backups (e.g. daily `pg_dump` plus point-in-time recovery), add monitoring/alerting, and consider PostgreSQL RLS as defence in depth

## Scaling notes

- The API is stateless apart from in-process jobs. When running more than one instance, move `jobs.ts` to a queue (pg-boss or BullMQ) and use S3 for uploads.
- Report and result computation runs on demand. Cache published exam results if very large schools make dashboards slow.
