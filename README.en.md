# GitHub Backup Worker

**English** | [简体中文](./README.md)

A zero-server, automatic GitHub repository backup solution built on Cloudflare Workers. When a repository is pushed, a GitHub Webhook wakes the Worker to fetch the tarball and store it in R2, while the backup record is written to D1. The built-in admin panel lets you view logs, manually back up a single repository or an entire organization, and download or delete historical backups; the retention counts for both backups and failed records can also be adjusted from the panel, along with a cap on R2 space usage.

## Architecture

- **GitHub Webhook**: triggered on repository push, with HMAC-SHA256 signature verification
- **Cloudflare Worker**: receives the Webhook, fetches the tarball, writes to R2/D1, and hosts the admin page
- **R2**: stores the `.tar.gz` backup files
- **D1**: the `backups` table holds backup records; the `settings` table holds panel settings (`r2_max_gb`, `backup_paused`, `backup_retain_count`, `backup_failed_retain_count`)
- **KV**: temporarily stores the progress and results of single-repo backups (`manual_backup_result`), full backups (`sync_result`), and batch cleanup (`cleanup_result`)

## Features

- ✅ Fully automatic backup: GitHub Webhook triggers automatic backups (HMAC-SHA256 signature verification)
- ✅ Built-in admin panel: log list, filtering by [repository / author / organization], download, delete; the panel supports real-time switching between Chinese and English
- ✅ Manual single-repo backup: validates that the repository exists before submitting; when the branch is left blank, it automatically detects the repository's default branch (main / master / develop, etc.)
- ✅ Full organization backup: compares `pushed_at` to automatically skip repositories with no updates; the number processed per run is adjustable; a summary popup shows the success / failure / skipped counts when done
- ✅ Batch cleanup of old backups: when you lower the retention count and save, the excess backups are counted and a confirmation popup appears, after which they are deleted in the background in batches; completion or failure both trigger a popup
- ✅ R2 space circuit-breaker protection: when usage exceeds the configured cap, redundant old backups are cleaned up first (keeping only the latest one per repository); if still insufficient, all backup functions are paused
- ✅ Low resource usage: runs within Cloudflare's free tier (R2 10GB / D1 5GB / KV writes 1000/day / Worker 100,000 requests/day)

## Project Structure

```text
github-backup-worker/
├── wrangler.toml         # Wrangler configuration (D1/R2/KV bindings, custom domain routes)
├── init.sql              # D1 initialization script (backups table, settings table and indexes)
├── src/
│   ├── index.js          # Worker core logic (routing, backup, admin panel, API)
│   └── i18n.js           # UI bilingual dictionary (Chinese / English)
├── .env.example          # Local development environment variable example
├── .gitignore
├── LICENSE               # MIT
├── RESOURCE-LIMITS.md    # Free-tier usage estimation and WAF hardening advice (Chinese)
├── RESOURCE-LIMITS.en.md # Same as above (English)
├── README.md             # Chinese documentation
└── README.en.md          # English documentation (this file)
```

## Prerequisites

- A Cloudflare account (the free plan is enough)
- Node.js 18+
- A GitHub Personal Access Token (**classic** type, with the `repo` scope checked; if you only back up public repositories, `public_repo` is also fine)

## Deployment Steps

### 1. Clone the project locally

```bash
git clone https://github.com/ycscg-org/github-backup-worker.git
cd github-backup-worker
```

### 2. Log in to Wrangler

```bash
npx wrangler login
```

### 3. Create Cloudflare resources

```bash
npx wrangler r2 bucket create github-backup-bucket
npx wrangler d1 create github-backup-db
npx wrangler kv namespace create bakgit-status-kv
```

- `d1 create` outputs a `database_id`; fill it into `wrangler.toml`.
- `kv namespace create` outputs the KV `id`; fill it into `wrangler.toml`.

### 4. Edit the configuration file (⚠️ the most important step)

After creating the R2 bucket, D1 database, and KV namespace in the terminal, you must edit `wrangler.toml` to bind the resources to your own Cloudflare account. If you do not, the deployment will certainly fail.

Open `wrangler.toml` in the project root with a text editor; you need to change four places:

**① Change the D1 database ID**

Find the `[[d1_databases]]` section:

```toml
[[d1_databases]]
binding = "DB"
database_name = "github-backup-db"
database_id = "66666f4a-d0f9-486d-8541-137199dd8468"   # replace with your own ID
```

👉 How to find your ID? Run `npx wrangler d1 list`, locate the `github-backup-db` you just created, and copy the corresponding UUID to replace the content inside the quotes.

**② Change the R2 bucket name**

Find the `[[r2_buckets]]` section:

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "github-backup-bucket"   # replace with your own bucket name
```

👉 How to find the bucket name? Run `npx wrangler r2 bucket list`, locate the bucket you created and replace it (if you copied the creation command above exactly, this will be `github-backup-bucket` and no change is needed).

**③ Change the custom domain route (or comment it out)**

Find the `routes` section:

```toml
routes = [
  { pattern = "fkgit.ai99cn.com/*", zone_name = "ai99cn.com" }
]
```

👉 Note:

- Here "ai99cn.com" is the author's own domain. If you have your own domain on Cloudflare, change it to your own "subdomain" and "root domain".
- If you do not have your own domain, you must add a `#` in front of the three lines `routes = [`, `{ pattern...}` and `]` to comment them out. Otherwise deployment will fail with a "domain not found" error.

**④ Change the KV namespace ID**

Find the `[[kv_namespaces]]` section (add it manually if it is missing):

```toml
[[kv_namespaces]]
binding = "KV"
id = "7109ce428e324caa821c8bd2722a236b" # replace with the KV ID you just created
```

👉 Note: `binding` must be written as `"KV"` and must not be changed, otherwise `env.KV` in the code will fail.

### 5. Initialize the D1 schema

```bash
npx wrangler d1 execute github-backup-db --remote --file=./init.sql
```

`init.sql` creates two tables:

- `backups`: backup records (`repo_name`, `branch`, `file_name`, `file_size`, `status`, `error_msg`, `created_at`) and their indexes
- `settings`: panel settings (`r2_max_gb`, `backup_paused`, `backup_retain_count`, `backup_failed_retain_count`)

### 6. Set the Secrets

This project needs three Secrets: `GITHUB_TOKEN`, `WEBHOOK_SECRET`, `ADMIN_PASSWORD`. All three values are written one by one via `wrangler secret put`; after running the command the terminal prompts `Enter a secret value:`, and you paste the content and press Enter (input is not echoed). Running a command with the same name again simply overwrites the old value.

#### 6.1 Generate a GitHub PAT (classic)

`GITHUB_TOKEN` is the key credential that lets the Worker fetch code smoothly; it mainly serves two purposes:
1. **Bypass API rate limits**: unauthenticated requests are limited to 60 per hour, while authenticated requests can reach 5000 per hour. Without a Token, "full organization backup" can easily hit the rate limit and fail in large batches.
2. **Read private repositories**: although public repositories can be fetched without a Token, if you want to back up **your own private repositories**, or other people's private repositories you have access to as a collaborator, you must provide authorization via a Token.

GitHub has two types of Token: Fine-grained and classic. This project **does not use Fine-grained Tokens**—each one can only authorize repositories under a single resource owner (yourself or one organization), so cross-organization or batch backups require generating them one by one and easily miss repositories, causing gaps in batch backups. Therefore **Personal access tokens (classic)** are used uniformly: a single `repo` scope covers all repositories accessible under your account.

Generation steps:

1. Log in to GitHub and click your avatar in the top-right corner → **Settings**.
2. In the left sidebar, scroll to the bottom and click **Developer settings**.
3. Choose **Personal access tokens** → **Tokens (classic)** → click **Generate new token (classic)**.
4. Fill in a **Note** (a name of your choice, such as `github-backup-worker`) and set an **Expiration** (90 days is recommended; you can also choose No expiration in the dropdown, but it is not recommended).
5. **Select scopes**: check **repo** (this project only needs to read repository content; classic has no finer read-only option, so checking `repo` is fine; if you only back up public repositories, `public_repo` is enough as well).
6. Click **Generate token** at the bottom, and the page will show a token starting with `ghp_`. **This token is shown only once, so copy and save it immediately.**
7. If the token needs to access an organization with SAML SSO enabled, after generating it you must also click **Configure SSO** → **Authorize** in the token list to complete the authorization, otherwise accessing that organization's private repositories will return 404.

Once you have the token, write it as a Secret:

```bash
npx wrangler secret put GITHUB_TOKEN      # paste the ghp_xxx generated in the previous step
```

#### 6.2 Generate a random string as WEBHOOK_SECRET

`WEBHOOK_SECRET` is used to verify the HMAC-SHA256 signature of the GitHub Webhook and needs a sufficiently random string. You can generate one with the command below (choose either one, run it in your local terminal):

```bash
# Option 1: openssl (built into macOS/Linux)
openssl rand -hex 32

# Option 2: Node.js (available when Node is installed)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the random string output by the command and write it as a Secret:

```bash
npx wrangler secret put WEBHOOK_SECRET    # paste the random string generated in the previous step; make sure it matches the Secret in step 8 "Configure the GitHub Webhook"
```

#### 6.3 Set the admin panel password ADMIN_PASSWORD

`ADMIN_PASSWORD` is the login password for the admin panel; you can set it to any string that you find easy to remember yet hard to guess (letters in both cases, numbers, and a length of 12 or more are recommended).

```bash
npx wrangler secret put ADMIN_PASSWORD    # set your own admin panel password and remember it for login
```

### 7. Deploy

```bash
npx wrangler deploy
```

(If you have previously run `npm install`, you can also use the shorter `npm run deploy`)

After deployment you get `https://github-backup-worker.<your-subdomain>.workers.dev`. To bind a custom domain, bind a Custom Domain to the Worker in the Cloudflare console, change the `routes` in `wrangler.toml` to your domain, and `deploy` again.

### 8. Configure the GitHub Webhook

You have two ways to configure the Webhook to trigger backups:

**Option A: Repository-level configuration (suitable for a few repositories)**

Target repository → Settings → Webhooks → Add webhook:

- **Payload URL**: `https://<your Worker address>/webhook`
- **Content type**: `application/json`
- **Secret**: the same as `WEBHOOK_SECRET`
- **Events**: Just the push event

**Option B: Organization-level configuration (recommended, suitable for batch backup of many repositories)**

If you have multiple repositories to back up, it is strongly recommended to move them under a single GitHub Organization and then configure an organization-level Webhook:

1. Go to your GitHub Organization page → Settings → Webhooks → Add webhook.
2. Fill in the same Payload URL, Content type, and Secret.
3. Choose Just the push event as the trigger event and save.

Once configured, every repository under that organization (including ones created later) will automatically trigger a backup on push, without setting them up one by one.

## Using the Admin Panel

Visit the Worker root path and enter the `ADMIN_PASSWORD` to log in to the admin panel.

**Manual single-repo backup**

1. Fill in `owner/repo`; the branch can be left blank, and when left blank the repository's default branch is detected automatically
2. After clicking "Start Backup", it first verifies whether the repository exists; a typo or a non-existent branch triggers an immediate popup prompt
3. Once submitted successfully, the button shows the branch actually used; when the background job finishes, a popup shows the result and the log list below refreshes automatically

**Full organization backup**

1. Fill in the organization name and set the "max backups per run" count (default 10, range 1–100)
2. The system automatically skips repositories whose latest backup time is later than the repository's `pushed_at`, filling in only those with updates
3. When done, a popup summarizes the success, failure, and skipped counts for this run

**System Settings**

- "R2 max available space": sets the upper limit of space (GB) available for backups, default 8. If multiple Workers share the same R2 bucket, deduct the space used by other projects
- "Max backups kept per repository/branch": sets the number of successful backups kept for each (repository, branch), default 5, range 1–100. When you lower the value and save, it first counts and prompts how many old backups will be deleted; after confirmation the excess backups are deleted in the background in batches (removing both the R2 files and the D1 records), and both completion and mid-way failure trigger a result popup
- "Max failed records kept": sets the number of failed records kept for each (repository, branch), default 10, range 0–10000. Lowering the value likewise asks for confirmation first and then deletes the excess failed records in the background in batches (failed records have no R2 file, only the D1 record is deleted); setting it to 0 and saving clears all historical failed records, equivalent to a one-click cleanup of the failure log
-     When the space runs low and the circuit breaker triggers, a red banner appears at the top of the page; after cleaning up old backups to free space, click "Resume Backup" to clear it

**Log list**

- Supports dropdown filtering by [repository name and author/organization] to avoid misreading
- Successful records can be "Downloaded" (`.tar.gz`) or "Deleted"; deletion clears both the R2 file and the D1 record, and failed records also support manual cleanup

**Interface Language**

- Both the login page and the admin page have a "中文 / EN" toggle button; clicking it switches the entire interface instantly, defaulting to Chinese on first visit
- The language choice is saved locally in the browser (`localStorage` key `backup_manager_lang`) and is reused automatically the next time you open the page

## Environment Variables

This project needs three Secrets, all set via `wrangler secret put` (see step 6 above); no Var needs to be configured in `wrangler.toml`.

| Name | Type | Description |
|---|---|---|
| `GITHUB_TOKEN` | Secret | GitHub PAT, used to fetch tarballs |
| `WEBHOOK_SECRET` | Secret | Webhook HMAC verification key |
| `ADMIN_PASSWORD` | Secret | Admin panel password |

## Local Development

```bash
cp .env.example .dev.vars   # fill in the real values
npx wrangler dev
```

`.dev.vars` is ignored by `.gitignore`.

## Known Limitations

- Only handles `refs/heads/*` push events; does not handle tags, branch deletions, etc.
- No scheduled full backup (triggered only by Webhook; if you need scheduling, implement a `scheduled` handler yourself)
- A single Worker request has a CPU time limit, so very large repositories may time out
- Backups are tarball snapshots provided by GitHub, not a complete Git repository (no `.git` history)

## Free Tier & Security Hardening

For an estimation of Cloudflare free-tier consumption per operation after deployment, the thresholds at which each quota is hit, and WAF rate limiting advice to prevent quota abuse, see [Resource Usage & Security Hardening](RESOURCE-LIMITS.en.md).

## License

MIT
