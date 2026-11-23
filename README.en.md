# GitHub Backup Worker

**English** | [简体中文](./README.md)

A zero-server, automatic GitHub repository backup solution built on Cloudflare Workers. On every repository push, a GitHub Webhook wakes the Worker to pull the tarball into R2 and write the backup record to D1. A built-in admin panel lets you browse logs, manually back up a single repository or an entire organization, download and delete historical backups, and configure how many backups and failure records to keep — with live progress feedback and R2 storage circuit-breaker protection. The admin panel supports instant switching between Chinese and English.

## Architecture

- **GitHub Webhook**: triggered on repository push, verified with an HMAC-SHA256 signature
- **Cloudflare Worker**: receives Webhooks, pulls tarballs, writes to R2/D1, and serves the admin panel
- **R2**: stores `.tar.gz` backup files
- **D1**: the `backups` table holds backup records; the `settings` table holds panel settings (`r2_max_gb`, `backup_paused`, `backup_retain_count`, `backup_failed_retain_count`)
- **KV**: temporarily holds the progress and results of single-repository backups (`manual_backup_result`), organization-wide backups (`sync_result`), and batch cleanup (`cleanup_result`)

## Features

- ✅ Automatic backups triggered by GitHub Webhook (HMAC-SHA256 signature verification)
- ✅ Streaming upload to R2 (`FixedLengthStream`, no OOM on large repositories)
- ✅ Built-in admin panel: log list, filter by repository, download, delete
- ✅ Manual single-repository backup: validates that the repository exists before submitting; when the branch is left empty it auto-detects the default branch (main / master / develop, etc.)
- ✅ Organization-wide backup: compares `pushed_at` to skip repositories with no updates; the per-run batch size is configurable; a summary dialog reports the succeeded / failed / skipped counts when finished
- ✅ Backup retention policy: keeps the latest N successful backups per (repository, branch); N is configurable in the admin panel (default 5)
- ✅ Batch cleanup of old backups: when you lower the retention count, the excess backups are counted and a confirmation dialog appears; after you confirm, they are deleted in the background, with a dialog reporting success or failure
- ✅ Failed-record retention policy: keeps the latest M failed records per (repository, branch); M is configurable in the admin panel (default 10); setting it to 0 clears all historical failure logs
- ✅ R2 storage circuit breaker: when usage exceeds the configured limit it first auto-cleans redundant old backups (keeping only the latest one per repository); if that is still not enough it pauses all backups
- ✅ The admin panel supports instant switching between Chinese and English (on both the login page and the admin page; the choice is saved in the browser)
- ✅ Runs within the Cloudflare free tier (R2 10 GB / D1 5 GB / KV 1,000 writes per day / Worker 100,000 requests per day)

## Project Structure

```text
github-backup-worker/
├── wrangler.toml         # Wrangler config (D1/R2/KV bindings, custom domain routes)
├── init.sql              # D1 init script (backups and settings tables, indexes)
├── src/
│   ├── index.js          # Worker core logic (routing, backup, admin panel, API)
│   └── i18n.js           # UI dictionaries (Chinese / English)
├── .env.example          # Local development environment variable template
├── .gitignore
├── LICENSE               # MIT
├── RESOURCE-LIMITS.md    # Free-tier usage estimates & WAF hardening advice (Chinese)
├── RESOURCE-LIMITS.en.md # Free-tier usage estimates & WAF hardening advice (English)
├── README.md             # Chinese documentation
└── README.en.md          # English documentation (this file)
```

## Prerequisites

- A Cloudflare account (the free plan is enough)
- Node.js 18+
- A GitHub Personal Access Token (**classic**, with the `repo` scope; `public_repo` is also enough if you only back up public repositories)

## Deployment

### 1. Clone the project

```bash
git clone https://github.com/ycscg-org/github-backup-worker.git
cd github-backup-worker
```

### 2. Log in to Wrangler

```bash
npx wrangler login
```

### 3. Create the Cloudflare resources

```bash
npx wrangler r2 bucket create github-backup-bucket
npx wrangler d1 create github-backup-db
npx wrangler kv namespace create bakgit-status-kv
```

- `d1 create` outputs a `database_id`; put it into `wrangler.toml`.
- `kv namespace create` outputs the KV `id`; put it into `wrangler.toml`.

### 4. Edit the config file (⚠️ the most important step)

After creating the R2 bucket, D1 database, and KV namespace, you must edit `wrangler.toml` to bind these resources to your own Cloudflare account. If you skip this, deployment will fail.

Open `wrangler.toml` in the project root with a text editor and change the following four places:

**① Update the D1 database ID**

Find the `[[d1_databases]]` block:

```toml
[[d1_databases]]
binding = "DB"
database_name = "github-backup-db"
database_id = "66666f4a-d0f9-486d-8541-137199dd8468"   # replace with your own ID
```

👉 How to find your ID: run `npx wrangler d1 list`, find the `github-backup-db` you just created, and copy its UUID into the quotes.

**② Update the R2 bucket name**

Find the `[[r2_buckets]]` block:

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "github-backup-bucket"   # replace with your own bucket name
```

👉 How to find the bucket name: run `npx wrangler r2 bucket list`, find the bucket you created and replace it (if you used the command above, this is already `github-backup-bucket` and needs no change).

**③ Update the custom domain route (or comment it out)**

Find the `routes` block:

```toml
routes = [
  { pattern = "fkgit.ai99cn.com/*", zone_name = "ai99cn.com" }
]
```

👉 Notes:

- `ai99cn.com` is the author's own domain. If you have your own domain on Cloudflare, change it to your own subdomain and root domain.
- If you don't have a domain, you must comment out the three lines `routes = [`, `{ pattern...}`, and `]` by prefixing each with `#`. Otherwise deployment fails with a "zone not found" error.

**④ Update the KV namespace ID**

Find the `[[kv_namespaces]]` block (add it manually if missing):

```toml
[[kv_namespaces]]
binding = "KV"
id = "7109ce428e324caa821c8bd2722a236b" # replace with the KV ID you just created
```

👉 Note: the binding must be `"KV"` — do not change it, or `env.KV` in the code will fail.

### 5. Initialize the D1 schema

```bash
npx wrangler d1 execute github-backup-db --remote --file=./init.sql
```

`init.sql` creates two tables:

- `backups`: backup records (`repo_name`, `branch`, `file_name`, `file_size`, `status`, `error_msg`, `created_at`) and their indexes
- `settings`: panel settings (`r2_max_gb`, `backup_paused`, `backup_retain_count`, `backup_failed_retain_count`)

### 6. Set secrets

This project needs three secrets: `GITHUB_TOKEN`, `WEBHOOK_SECRET`, and `ADMIN_PASSWORD`. All three are written one by one with `wrangler secret put`; the terminal then prompts `Enter a secret value:` — paste the value and press Enter (input is not echoed). Running the same command again overwrites the old value.

#### 6.1 Create a GitHub PAT (classic)

`GITHUB_TOKEN` is the credential that lets the Worker pull code, and it has two main purposes:

1. **Avoid API rate limits**: unauthenticated requests are limited to 60 per hour, while authenticated requests allow 5,000 per hour. Without a token, organization-wide backups easily hit the rate limit and fail en masse.
2. **Read private repositories**: although public repositories can be pulled without a token, you must provide one to back up **your own private repositories** or private repositories you can access as a collaborator.

GitHub offers two kinds of tokens: Fine-grained and classic. This project **does not use Fine-grained tokens** — each one authorizes repositories under only a single resource owner (yourself or one organization), so cross-organization or batch backups require generating many tokens one by one and easily miss repositories. Instead it uses **Personal access tokens (classic)**: a single `repo` scope covers every accessible repository under the account.

Steps:

1. Sign in to GitHub and click your avatar in the top-right → **Settings**.
2. Scroll the left sidebar to the bottom and click **Developer settings**.
3. Choose **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)**.
4. Fill in **Note** (any name, e.g. `github-backup-worker`) and set **Expiration** (90 days recommended; No expiration is available but not recommended).
5. Under **Select scopes**, check **repo** (this project only needs to read repository content; classic has no finer read-only scope, so `repo` is fine — if you only back up public repositories, `public_repo` is enough).
6. Click **Generate token** at the bottom; the page shows a token starting with `ghp_`. **It is displayed only once, so copy and save it immediately.**
7. If the token must access an organization with SAML SSO enabled, after creating it click **Configure SSO** → **Authorize** in the token list; otherwise accessing that organization's private repositories returns 404.

Once you have the token, store it as a secret:

```bash
npx wrangler secret put GITHUB_TOKEN      # paste the ghp_xxx token generated above
```

#### 6.2 Generate a random string for WEBHOOK_SECRET

`WEBHOOK_SECRET` is used to verify the HMAC-SHA256 signature of the GitHub Webhook and must be a sufficiently random string. Generate one with either command below (run it in your local terminal):

```bash
# Option 1: openssl (bundled with macOS/Linux)
openssl rand -hex 32

# Option 2: Node.js (if Node is installed)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output and store it as a secret:

```bash
npx wrangler secret put WEBHOOK_SECRET    # paste the random string generated above; it must match the Secret in step 8 "Configure the GitHub Webhook"
```

#### 6.3 Set the admin panel password ADMIN_PASSWORD

`ADMIN_PASSWORD` is the login password for the admin panel. Choose any string that is easy for you to remember but hard to guess (include upper- and lowercase letters and digits, 12+ characters recommended).

```bash
npx wrangler secret put ADMIN_PASSWORD    # set your own admin panel password and remember it for login
```

### 7. Deploy

```bash
npx wrangler deploy
```

(If you have run `npm install` before, you can also use the shorthand `npm run deploy`.)

After deployment you get `https://github-backup-worker.<your-subdomain>.workers.dev`. To bind a custom domain, add a Custom Domain for the Worker in the Cloudflare dashboard, change the `routes` in `wrangler.toml` to your domain, and run `deploy` again.

### 8. Configure the GitHub Webhook

There are two ways to trigger backups via Webhook:

**Option A: repository-level (good for a few repositories)**

Target repository → Settings → Webhooks → Add webhook:

- **Payload URL**: `https://<your-worker-url>/webhook`
- **Content type**: `application/json`
- **Secret**: same as `WEBHOOK_SECRET`
- **Events**: Just the push event

**Option B: organization-level (recommended, good for many repositories)**

If you have several repositories to back up, it is strongly recommended to move them under a GitHub Organization and configure an organization-level Webhook:

1. Go to your GitHub Organization page → Settings → Webhooks → Add webhook.
2. Fill in the same Payload URL, Content type, and Secret.
3. Select Just the push event and save.

After that, all repositories under the organization (including future ones) trigger a backup automatically on push — no need to configure each repository.

## Using the Admin Panel

Visit the Worker root path and log in with `ADMIN_PASSWORD`.

**Manual single-repository backup**

1. Enter `owner/repo`; the branch may be left empty and will be auto-detected
2. Click "Start Backup" — the repository is validated first, and a wrong spelling or missing branch triggers an immediate dialog
3. After submitting, the button shows the actual branch used; when the background job finishes a dialog reports the result and the log list refreshes automatically

**Organization full backup**

1. Enter the organization name and set "Max backups per run" (default 10, range 1–100)
2. The system automatically skips repositories whose last backup is newer than `pushed_at`, and only fills in those with updates
3. When finished, a dialog summarizes the succeeded, failed, and skipped counts

**System Settings**

- "Max R2 Storage": the storage limit available for backups (GB), default 8. If several Workers share one R2 bucket, subtract the space used by other projects
- "Max backups per repo/branch": how many successful backups to keep per (repository, branch), default 5, range 1–100. When you lower it and save, the app counts the old backups to be deleted and shows a confirmation dialog; after you confirm, the excess backups are deleted in the background (both the R2 file and the D1 record are removed), and a dialog reports success or failure
- "Max failed records to keep": how many failed records to keep per (repository, branch), default 10, range 0–10000. Lowering it also shows a confirmation dialog and then batch-deletes the excess failed records in the background (failed records have no R2 file, so only D1 records are deleted); setting it to 0 and saving clears all historical failure records — equivalent to clearing the failure logs in one click
- When a space shortage trips the circuit breaker, a red banner appears at the top of the page; free up space by cleaning old backups and click "Resume Backups" to lift it

**Log list**

- Filter by repository name via the dropdown to avoid confusion
- Successful records can be "Downloaded" (`.tar.gz`) or "Deleted"; deletion removes both the R2 file and the D1 record. Failed records can also be cleaned up manually

**Interface language**

- Both the login page and the admin page have a "中文 / EN" switch in the top-right corner; clicking it switches the whole interface instantly, with no refresh or re-login
- The choice is saved in the browser's `localStorage` (key `backup_manager_lang`) and reused on the next visit; the first visit defaults to Chinese

## Adding a New Language

- All UI text lives in the `dict` object in `src/i18n.js`; `zh` and `en` correspond to Chinese and English
- To add a language, add a new language key to `dict` (e.g. `ja`) and translate every entry following the structure of `en`
- Then add a button to the language switcher on both the login page and the admin page (calling `setLang('ja')`), and register the display name in `getSupportedLangs()`

## Environment Variables

This project needs only three secrets, all set with `wrangler secret put` (see step 6 above). No Vars need to be configured in `wrangler.toml`.

| Name | Type | Description |
|---|---|---|
| `GITHUB_TOKEN` | Secret | GitHub PAT, used to pull tarballs |
| `WEBHOOK_SECRET` | Secret | Webhook HMAC verification key |
| `ADMIN_PASSWORD` | Secret | Admin panel password |

> Note: the retention counts for successful and failed backups are now configured in the admin panel under "System Settings" and stored in the D1 `settings` table (keys `backup_retain_count` and `backup_failed_retain_count`), defaulting to 5 and 10. The `BACKUP_RETAIN_COUNT_DEFAULT` and `BACKUP_FAILED_RETAIN_COUNT_DEFAULT` constants near the top of `src/index.js` are only the fallbacks used when a setting is unset — no code change is needed.

## Local Development

```bash
cp .env.example .dev.vars   # fill in real values
npx wrangler dev
```

`.dev.vars` is ignored by `.gitignore`.

## Known Limitations

- Only `refs/heads/*` push events are handled; tags and branch deletions are not
- No scheduled full backup (Webhook trigger only; add a `scheduled` handler yourself if you need a timer)
- A Worker request has a CPU-time limit, so very large repositories may time out
- Backups are the tarball snapshots provided by GitHub, not a complete Git repository (no `.git` history)

## Free-Tier Usage & Security Hardening

For estimates of how each operation consumes the Cloudflare free tier, the thresholds at which each quota is exhausted, and WAF rate-limiting advice to prevent abuse, see [Resource Usage Estimates & Security Hardening](RESOURCE-LIMITS.en.md).

## License

MIT
