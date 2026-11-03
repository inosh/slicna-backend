# SLICNA backend

Express + PostgreSQL API for the SLICNA website (`slicna` repo) and its admin panel. Uploaded images are stored on local disk in `uploads/` for now; the plan is to move them to Cloudflare R2 later, as was done for SLNA.

## First-time setup

Requires Node.js 18+ and PostgreSQL, with an empty database (default name `slicna_db`).

1. Copy `.env.example` to `.env` and fill in the database details. Generate `JWT_SECRET` with `node generate-secret.js`.
2. Install, then create the tables, load the starting content, and create your admin login:

```bash
npm install
npm run init-db
npm run seed
npm run create-admin
```

3. Start the API (it runs on port **3001**, so it can run next to the SLNA backend on 3000):

```bash
npm run dev
```

Check it at http://localhost:3001/api/health. Then run the frontend (`npm run dev` in the `slicna` repo) and log in at http://localhost:5173/pages/admin-login.html.

## Scripts

| Command | What it does |
|---|---|
| `npm run init-db` | Runs `db/schema.sql`. Safe to re-run. |
| `npm run seed` | Loads the site's starting content and photos (from `db/seed-images/`). Only runs on an empty database. |
| `npm run seed -- --reset` | **Deletes all content and uploaded photos** (not admin users), then seeds again. |
| `npm run create-admin` | Creates an admin user (asks for username and password). |
| `npm run dev` / `npm start` | Starts the API (with or without auto-restart). |
| `npm run reminders` | Sends due membership renewal reminders. Schedule it **once a day** (for example a Railway cron service, like SLNA's backup job). |

## API

Reads are public; everything else needs `Authorization: Bearer <token>` from `POST /api/auth/login`. Writes take `multipart/form-data`. Images go in the field named below, and `remove_image=true` clears an existing image on update.

| Resource | Endpoints | Image field |
|---|---|---|
| Auth | `POST /api/auth/login`, `POST /api/auth/change-password` | |
| News | `GET/POST /api/news`, `GET/PUT/DELETE /api/news/:id` | `photo` |
| Events (incl. CPD) | `GET/POST /api/events`, `GET/PUT/DELETE /api/events/:id` | `photo` |
| Milestones (About page) | `GET/POST /api/milestones`, `GET/PUT/DELETE /api/milestones/:id` | |
| Settings | `GET /api/settings`, `PUT /api/settings/images/about_journey_photo` | `photo` |
| Executive Committee | `GET /api/committee` (term + members), `PUT /api/committee/settings`, `POST /api/committee/members`, `PUT/DELETE /api/committee/members/:id` | `photo` |
| Community page | `GET /api/community` (sections with items), `POST/PUT/DELETE /api/community/sections[/:id]`, `POST/PUT/DELETE /api/community/items[/:id]` | `logo` / `image` |
| Gallery | `GET /api/albums` (with photos), `POST /api/albums` (album plus its first photos: `photos`, 1 to 30, required), `PUT/DELETE /api/albums/:id`, `POST /api/albums/:id/photos` (`photos`, up to 30), `PUT/DELETE /api/albums/photos/:photoId` | |

Most content types share one implementation in `lib/crud.js`; each route file only lists its fields and validation.

## Membership

Four categories: **LT** Lifetime (paid once, never expires), **GM** General, **OM** Ordinary and **PM** Partial (students). GM, OM and PM are valid for 12 months at a time.

**Public endpoints** (`routes/membership.js`, no login, rate limited):

| Endpoint | Purpose |
|---|---|
| `GET /api/membership/info` | Fees, bank details, grace period |
| `POST /api/membership/applications` | Apply (multipart). Files: `photo` (image), `receipt` (image/PDF), `endorsement` (GM/OM/PM: signed recommendation or institution letter). Returns a reference like `APP-7KQ2M9XA` |
| `POST /api/membership/status` | Application status from reference + NIC |
| `POST /api/membership/renew/lookup` | Membership number + NIC → short-lived renewal token |
| `GET /api/membership/renew/:token` | What the renewal page shows |
| `POST /api/membership/renew/:token` | Submit a renewal or upgrade (`kind`, `nic_last4`, `payment_date`, `receipt`, optional contact updates) |

**Admin endpoints** are under `/api/membership/admin/*` (all need a login): applications review, member directory (add, edit, CSV export, deactivate/reactivate, ID application PDF, renewal links, recording cash payments), renewals verification, fees, bank details and reminder settings. See the header comment in `routes/membership-admin.js` for the full list.

**How the lifecycle works:**
- **Approval:** creates a member with a membership number (suggested as `GM 0012/26`: category, 4-digit serial, year). For GM/OM/PM the admin confirms a start date, which defaults to the day the application was submitted, and the membership is valid for one year from it. Lifetime members start on the approval date and never expire.
- **Application form rules:** every field on the paper forms is required except WhatsApp, residential and office phones and higher qualifications (the same optional fields as SLNA's join form). SLNC and SLNA numbers and dates are required unless the applicant ticks "I don't have it yet". Titles, marital statuses and phone rules match SLNA's join form.
- **Status:** each member's status (active, renewal due, grace period, lapsed) is **calculated from `valid_until` and the grace setting**, so lapsing happens automatically without a job. Deactivation is a manual admin action.
- **Renewal before the grace period ends:** extends from the old expiry date. **Renewal after lapsing:** starts a new year from the verification date. Upgrades make the member Lifetime with a new LT number.
- **Reminders:** `npm run reminders` sends at most one reminder per stage and period, with a fresh personal renewal link: 30 and 7 days before expiry, on expiry, 14 days before the grace period ends, and on lapsing. Members with a pending renewal are skipped.

**Private files:** application photos, payment slips, signed pages and renewal slips are stored in `private-uploads/` (never served publicly; streamed only to logged-in admins). Keys mirror a future R2 private bucket:
```
membership/applications/<reference>/photo-<ts>-<rand>.jpg
membership/applications/<reference>/receipt-…, endorsement-…
membership/renewals/<member id>/receipt-…
membership/members/<member id>/photo-…        (photos added by an admin)
```

**Email** goes through Resend (`lib/mail.js`). Until `RESEND_API_KEY` is set, emails are logged and skipped. The admin panel says so, and admins can copy a member's renewal link to send by WhatsApp or SMS.

## Notes

- **Public images:** saved as `uploads/<folder>/<timestamp>-<random>-<name>`. The database stores the public path (`/uploads/...`). Replaced or deleted images are removed from disk.
- **Not yet built:** the contact form, event registration, and the import of existing (legacy) members.
- `uploads/`, `private-uploads/` and `.env` are not committed to git.
