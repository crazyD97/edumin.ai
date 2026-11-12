# Messaging, payments & the parent app

How school alerts reach parents by WhatsApp, SMS and email, how message credits and online fees work, and what you have to register before going live in India.

## How a message is sent

1. A module raises an event, for example `attendance_absent` when a student is marked absent.
2. `notifyFamilies` / `notifyUsers` (`apps/api/src/core/notify.ts`) write the in-app notification and send a web push. They then call `dispatch` (`apps/api/src/modules/messaging/service.ts`).
3. `dispatch` checks the school's settings:
   - the plan has the `messaging` feature;
   - the channel is switched on;
   - the event is enabled for that channel (Messaging → Settings matrix).
4. It then reserves credits atomically and writes one row per recipient and channel to `outbound_messages`. The status is `queued`.
5. The `message-delivery` job (every 5 s) sends queued rows through the provider.
   - A row that fails is retried up to 3 times.
   - If it still fails, its status becomes `failed` and its credits are refunded.
6. WhatsApp delivery receipts arrive at `/api/webhooks/whatsapp` and update each row to `sent` → `delivered` / `read` / `failed`.

Each provider falls back to a **simulator** when its keys are not set, so development and tests never send anything real. The Messaging page shows which channels are live and which are simulated.

| Channel | Provider | Credits per message | Keys |
|---|---|---|---|
| Email | Resend | 0 | `EMAIL_DRIVER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` |
| WhatsApp | Meta WhatsApp Cloud API (platform number) | 1 | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` |
| SMS | MSG91 (DLT) | 1 | `MSG91_AUTH_KEY`, `MSG91_TEMPLATES` |

Recipients are normalised to `91XXXXXXXXXX`. A number that is not a valid Indian mobile is skipped.

## Credits

- The platform owns the WhatsApp number and SMS sender and sells credits to schools. The balance is stored in `schools.message_credits`, and every change is recorded in `credit_transactions`.
- **Packs** (`packages/shared/src/messaging.ts`):
  - Starter: 1,000 credits for ₹499.
  - School: 5,000 credits for ₹2,249.
  - Campus: 20,000 credits for ₹7,999.
- **Buying:** schools buy from Messaging → Credits. Payment goes through the **platform's** Razorpay account (`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`). Orders are idempotent, and the webhook `/api/webhooks/razorpay/platform` credits the pack even if the browser closes.
- **Manual adjustments:** the platform admin can grant or deduct credits from the school detail page. A balance can never go negative.
- **When credits run out:** paid channels are skipped, while email and in-app notifications still go out. School admins get a low-balance warning.

## Templates you must register

WhatsApp and Indian SMS only deliver pre-approved templates. Register each one with exactly the wording below, using **category: Utility** on Meta.

The placeholders are numbered in the order of the *Variables* column. For example, `{{1}}` is the first variable listed for that row.

| Event | WhatsApp template name | Variables (in order) | Text |
|---|---|---|---|
| `fee_reminder` | `edumin_fee_reminder` | school, student, amount, link | Dear Parent, the fee balance of {{amount}} for {{student}} at {{school}} is overdue. You can pay online here: {{link}} |
| `fee_receipt` | `edumin_fee_receipt` | school, student, amount, receipt | Dear Parent, {{school}} has received {{amount}} towards the fees of {{student}}. Receipt no. {{receipt}} is attached. Thank you. |
| `attendance_absent` | `edumin_absent_alert` | school, student, date | Dear Parent, {{student}} was marked absent at {{school}} on {{date}}. Please contact the school if this is unexpected. |
| `attendance_low` | `edumin_low_attendance` | school, student, percent, threshold | Dear Parent, the attendance of {{student}} at {{school}} is {{percent}}, below the required {{threshold}}. Please ensure regular attendance. |
| `exam_results` | `edumin_exam_results` | school, student, exam, result | Dear Parent, the results of {{exam}} at {{school}} are out. {{student}}: {{result}}. The report card is attached. |
| `exam_scheduled` | `edumin_exam_schedule` | school, exam, date | Dear Parent, {{school}} has published the schedule for {{exam}}, starting {{date}}. Please check the parent app for subject-wise dates. |
| `homework` | `edumin_homework` | school, student, title, due | Dear Parent, new homework for {{student}} at {{school}}: {{title}}. Due on {{due}}. |
| `meeting` | `edumin_meeting_update` | school, detail | {{school}}: {{detail}} |
| `announcement` | `edumin_announcement` | school, title, message | {{school}} – {{title}}: {{message}} |
| `event` | `edumin_event` | school, title, when | {{school}}: {{title}} on {{when}}. |
| `portal_credentials` | `edumin_portal_login` | school, name, login, password, link | Dear {{name}}, your {{school}} parent app is ready. Login: {{login}} Password: {{password}} Open: {{link}} |
| `admission` | `edumin_admission_update` | school, student, status, ref | Dear Parent, the admission application {{ref}} for {{student}} at {{school}} is now: {{status}}. |

- **Document header:** `fee_receipt` and `exam_results` carry a PDF (the receipt or the report card). Register them with a **Document** header.
  - The PDF is served through a signed, expiring link: `/api/public/messages/...`, HMAC-signed and valid for 7 days.
  - Set `PUBLIC_URL` so that Meta can reach the link.
- **SMS (DLT):** register the same text on your DLT portal, with `{#var#}` in place of each placeholder.
  - Put the resulting template IDs in `MSG91_TEMPLATES` as JSON, for example `{"attendance_absent":"6650…","fee_reminder":"6651…"}`.
  - Events without an ID are not sent by SMS.
- **Changing wording:** edit `apps/api/src/modules/messaging/templates.ts` and re-register the template. Meta rejects messages whose parameters don't match the approved template.

### Meta webhook

In the Meta app dashboard → WhatsApp → Configuration:

- Callback URL: `https://<your-domain>/api/webhooks/whatsapp`
- Verify token: `WHATSAPP_VERIFY_TOKEN`
- Subscribe to `messages`.

Each POST is checked against `X-Hub-Signature-256` using `WHATSAPP_APP_SECRET`.

## Online fee payments (Razorpay)

Each school connects **its own** Razorpay account, so money settles straight into the school's bank account. The platform never holds it.

- **Connecting:** Settings → Payments & integrations. The key secret and webhook secret are encrypted with AES-256-GCM using `SECRETS_KEY`, which falls back to `JWT_SECRET`, and are never returned by the API. "Test connection" checks the keys against Razorpay.
- **Webhook:** each school adds `https://<your-domain>/api/webhooks/razorpay/school/<schoolId>` with the event `payment.captured`.
- **Paying in the app:** parents pay from the Fees page. The checkout signature is verified on the server, and the amount is allocated to the oldest dues first. A receipt is then sent.
- **Paying from a link:** fee reminders include a **pay link**, `/pay/<studentId>?exp&sig`. The link is signed, valid for 30 days, and works without logging in.
- **Development:** set `PAYMENT_GATEWAY=mock` to get a simulated checkout. In production it defaults to `none`, and the mock endpoints refuse to complete payments.

## Certificates & ID cards

- **Issuing:** certificates are issued from a student's profile → Certificates tab. The types are Transfer (TC), Bonafide, Character and Study.
  - Each certificate gets a per-year serial number such as `TC/2026/0001`.
  - The student's details are snapshotted at the time of issue.
  - Issuing a TC can also mark the student as transferred.
- **Verifying:** every certificate and ID card carries a QR code that opens `/verify/<kind>/<id>`. That public page shows whether the certificate is genuine or has been revoked.
- **ID cards:** CR80 size, printed 10 to an A4 sheet, for students (by section) or staff.

## Parent app (PWA)

- **Installing:**
  - The web app installs to the home screen from the profile menu → Install app. iOS shows instructions for Add to Home Screen.
  - The manifest is generated per school (`/api/public/manifest.webmanifest?school=<slug>`), so the installed app carries the school's name and colour.
- **Caching:** the service worker (`apps/web/public/sw.js`) caches the app shell and assets. It keeps the last API responses for offline viewing and clears them on sign-out. It registers only in production builds.
- **Push notifications:** these need VAPID keys (`npx web-push generate-vapid-keys` → `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`). Users switch them on from the Notifications page.
- **Login by mobile:** parents sign in with their mobile number in any format, for example `+91 98765-43210`. Admins create parent logins in bulk from the Setup checklist and can send the credentials over WhatsApp or SMS.

## Go-live checklist

- [ ] `PUBLIC_URL` set to the public HTTPS origin
- [ ] `SECRETS_KEY` set (32+ random bytes) and backed up. If it is lost, schools must re-enter their Razorpay keys.
- [ ] Meta Business verified, WhatsApp number added, all 12 templates approved, webhook subscribed
- [ ] DLT entity, sender ID and templates approved; `MSG91_TEMPLATES` filled in
- [ ] Resend domain verified (SPF/DKIM) and `EMAIL_FROM` on that domain
- [ ] Platform Razorpay account live with webhook `/api/webhooks/razorpay/platform`
- [ ] VAPID keys generated
- [ ] `PAYMENT_GATEWAY` left unset (or `none`) in production
