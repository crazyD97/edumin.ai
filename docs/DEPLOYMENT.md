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
| `PUBLIC_URL` | | `APP_URL` | Public HTTPS origin used in pay links and WhatsApp attachments |
| `SECRETS_KEY` | | `JWT_SECRET` | Encrypts schools' Razorpay keys. Set it separately and back it up |
| `EMAIL_DRIVER` | | `console` | `console`, `resend` or `none` |
| `RESEND_API_KEY`, `EMAIL_FROM` | | — | Email via Resend |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | | — | Platform WhatsApp number (Cloud API). Unset = simulated |
| `MSG91_AUTH_KEY`, `MSG91_TEMPLATES` | | — | SMS via MSG91 with DLT template IDs. Unset = simulated |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | | — | Platform account that sells message credits |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | | — | Web push for the installed app |
| `PAYMENT_GATEWAY` | | `mock` in dev, `none` in production | `mock` enables simulated checkout. Never set it in production |
| `WEB_DIST` | | `../web/dist` | Built SPA to serve |

The web app reads `VITE_ROOT_DOMAIN` at build time (default `edumin.localhost`).

Provider setup, the template wording to register with Meta and DLT, and webhooks are covered in [MESSAGING.md](MESSAGING.md).

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
- [x] Third-party secrets encrypted at rest (AES-256-GCM); Razorpay and WhatsApp webhooks signature-checked; public pay, attachment and verify links HMAC-signed with expiry
- [x] Mock payment endpoints disabled unless `PAYMENT_GATEWAY=mock`
- [ ] Before go-live: enable HTTPS, rotate `JWT_SECRET`, configure Resend/WhatsApp/MSG91 (see MESSAGING.md go-live checklist), set up DB backups (e.g. daily `pg_dump` plus point-in-time recovery), add monitoring/alerting, and consider PostgreSQL RLS as defence in depth

## Scaling notes

- The API is stateless apart from in-process jobs. When running more than one instance, move `jobs.ts` to a queue (pg-boss or BullMQ) and use S3 for uploads.
- Report and result computation runs on demand. Cache published exam results if very large schools make dashboards slow.
