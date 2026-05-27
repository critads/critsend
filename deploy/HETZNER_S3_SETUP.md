# Activating Hetzner Object Storage for CSV imports

By default Critsend stores uploaded CSV import files on the **local disk** of
the web process at `/var/lib/critsend/uploads/imports/`. This works for small
deployments but breaks in two failure modes:

1. **PM2 restart / redeploy between upload and processing** — the file is gone
   when the worker picks the job up. UI shows: `CSV file not found: /var/lib/critsend/uploads/imports/import-….csv`.
2. **Multi-host clusters** — the uploading host's disk is invisible to the
   worker host.

The fix is to flip the storage backend to **Hetzner Object Storage** (S3-compatible).
All the code is already in place — this is an operational activation only.

## What gets persisted to S3

Only **CSV import payloads** (one object per import job, key `imports/{jobId}.csv`).
Image assets, sessions, logs, and the database are NOT affected.

After upload the local file in `IMPORT_UPLOAD_DIR` is **deleted** automatically,
so the persistent volume only ever holds in-flight chunked uploads, never
completed-and-queued imports.

## Step 1 — Provision the bucket on Hetzner

In the Hetzner Cloud Console → **Object Storage**:

1. Create a new bucket — recommended name: `critsend-imports`. Region: pick the
   one closest to your VM (e.g. `fsn1` for Falkenstein).
2. Generate an S3 access key pair: **Project → Security → S3 credentials → Create credentials**.
3. Note down the endpoint URL. For `fsn1` it is `https://fsn1.your-objectstorage.com`.

## Step 2 — Add 5 env vars + the activation flag to the prod server

On the prod VM (`/home/ubuntu/critsend/.env`):

```bash
# Activate the S3 backend (factory in server/storage-backends/index.ts)
STORAGE_BACKEND=hetzner

# Hetzner Object Storage credentials
HETZNER_S3_ENDPOINT=https://fsn1.your-objectstorage.com
HETZNER_S3_REGION=fsn1
HETZNER_S3_BUCKET=critsend-imports
HETZNER_S3_ACCESS_KEY=...           # from step 1
HETZNER_S3_SECRET_KEY=...           # from step 1
```

PM2's ecosystem (`deploy/ecosystem.config.cjs`) already spreads `.env` into
every process via `loadEnvFile()`, so all three processes (`critsend-web`,
`critsend-worker`, `critsend-drainer`) inherit the same values — no ecosystem
edit needed.

## Step 3 — Reload PM2

```bash
pm2 reload deploy/ecosystem.config.cjs --update-env --env production
```

`--update-env` is mandatory; without it PM2 keeps the old env in memory and
the new vars are ignored.

## Step 4 — Verify

```bash
# Boot log should contain exactly this line:
pm2 logs critsend-web | grep "\[STORAGE\]"
# → [STORAGE] Using Hetzner S3 backend (STORAGE_BACKEND=hetzner)
```

Then upload a small CSV via the UI and check:

```sql
SELECT id, csv_file_path, status
FROM import_jobs
ORDER BY created_at DESC
LIMIT 1;
-- csv_file_path should start with "/objects/imports/"
```

And confirm in the Hetzner console that `imports/{jobId}.csv` is present and
that `/var/lib/critsend/uploads/imports/` no longer contains the file.

## Resilience test

Start a larger import (~500k rows) and during processing run
`pm2 restart critsend-web`. The worker picks the job back up from Hetzner and
completes — no "CSV file not found" error.

## Rollback

To revert to local-disk storage:

```bash
# In .env, change to:
STORAGE_BACKEND=local
# (or comment out the line — unset defaults to local)

pm2 reload deploy/ecosystem.config.cjs --update-env --env production
```

In-flight jobs already uploaded to S3 keep being served from S3, because each
job's `csv_file_path` is the source of truth — the factory choice only affects
**new** uploads. So rollback is safe and immediate.

## Troubleshooting

- **Boot crash** `Missing required Hetzner env vars: HETZNER_S3_…` — one of
  the 5 vars is missing or empty. The constructor refuses to start rather
  than silently degrading.
- **Upload returns 5xx with `S3 access denied`** — the access key is missing
  bucket write permissions, or the bucket name in the env var doesn't match
  the bucket you created.
- **Import fails with `ObjectStorageNotFound`** — the upload step failed
  silently before the row was written, or someone manually deleted the object.
  The job is marked `failed` with a clear error and the UI shows the
  "Re-upload required" affordance.
