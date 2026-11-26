# Deploy to Render (about 15 minutes of clicking)

The repository contains a Render Blueprint (`render.yaml` at the repo root) that creates:

| Resource | Render type | Purpose |
|---|---|---|
| `jpg-analytics-db` | PostgreSQL 16 (basic-256mb) | all data; PostGIS is enabled by the first migration |
| `jpg-analytics` | Web service (Node 22, starter) | the app; runs migrations before every deploy |
| `jpg-analytics-refresh` | Cron job (Python 3.13, starter) | 5th of each month, 8:17 am HST: refresh all public data + quality checks |

Render shows the monthly price of each resource before you confirm.

## Steps

1. **Sign in** at https://dashboard.render.com (GitHub sign-in is easiest).
2. **New → Blueprint**. Connect GitHub if asked and pick the repository `jpghawaii/astro-blog-starter-template`.
3. **Branch**: choose `ccr-1744846a-4jolme` (or `main` after this branch is merged).
4. Render lists the three resources. It asks for two values:
   * `BOOTSTRAP_ADMIN_EMAIL` — your login email.
   * `BOOTSTRAP_ADMIN_PASSWORD` — a password of **12+ characters** (store it in your password manager).
5. Click **Apply**. First build + deploy takes roughly 5–10 minutes. Wait until `jpg-analytics` shows **Live**.
6. Open the web service URL (`https://jpg-analytics-xxxx.onrender.com`) and sign in with the email/password from step 4.
7. Go to **`/admin/restore`** (type it after the URL), choose the file **`jpg-data-bundle-20261126.sql.gz`** (sent to you separately — it contains confidential data; do not upload it anywhere else), click **Load data**. It finishes in seconds and shows the counts: 237 venues, 632 assets, 2,773 observations, 920 invoice lines.
8. **Lock it down** (Render → `jpg-analytics` → Environment):
   * set `RESTORE_ENABLED` to `0`,
   * delete `BOOTSTRAP_ADMIN_PASSWORD` (and `BOOTSTRAP_ADMIN_EMAIL`),
   * Save → the service redeploys.
9. Optional **custom domain**: `jpg-analytics` → Settings → Custom Domains → add e.g. `analytics.jpghawaii.com`, then add the CNAME record Render shows at your DNS provider. Render issues the HTTPS certificate automatically.
10. Optional: run the refresh job once now (`jpg-analytics-refresh` → **Trigger Run**) to confirm it works; afterwards it runs monthly.

## Adding team members
Until a user-admin page exists, create users from your computer with the database's **External Database URL**
(Render → `jpg-analytics-db` → Connect):
```bash
cd platform
DATABASE_URL='<external url>' NEW_USER_PASSWORD='12+ chars' npx tsx scripts/create-user.ts name@jpghawaii.com sales "Name"
```
Roles: `admin`, `analyst` (revenue, restricted sources, exception resolution), `sales` (contacts, client reports), `viewer`.

## Rehearsal (done before handing over)
On a fresh PostGIS database: migrations 001–008 applied; bootstrap admin created on first start; the bundle
loaded through `/admin/restore` in one transaction with counts identical to the source database; restore then
refused (database not empty); overview, venue, advertisers, reports, exceptions and sources pages returned 200.

## Notes
* Backups: Render takes daily backups of paid PostgreSQL instances; check the retention for the chosen plan.
* Secrets live only in Render's environment settings. Never commit `.env*` or anything in `data/private/`.
* Optional variables later: `MONDAY_API_TOKEN`, `QBO_*`, `CENSUS_API_KEY`, provider keys (see `docs/CREDENTIALS_NEEDED.md`).
