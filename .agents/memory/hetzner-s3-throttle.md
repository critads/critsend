---
name: Hetzner S3 throttle resilience
description: Why CSV import uploads must survive 503 SlowDown, and where that resilience lives
---

# Hetzner Object Storage 503 SlowDown resilience

Hetzner Object Storage throttles under bursts of concurrent multipart PUTs and
returns `503 SlowDown` (and sometimes `503` with an unparsed error name). A storm
can make **every** CSV import fail at once.

**Key insight — the upload is on the synchronous request path, not the worker.**
The CSV file is PUT to object storage *inside the HTTP handler* (`POST /api/import`
and the chunked-complete handler), then HEAD-verified, then the queue row is
committed. The typed-error → requeue-with-backoff mechanism only protects the
*worker job loop*; it does NOT cover this initial upload. So a transient 503 there
fails fast and the job is marked permanently `failed` ("Import setup failed:
[PUT]/[HEAD] ... 503 SlowDown"), which later surfaces to the user as "CSV file not
found, please re-upload".

**Resilience must therefore be inside the storage backend itself**
(`server/storage-backends/hetzner-s3.ts`), since both upload entry points call it:
- S3Client uses `retryMode: "adaptive"` (client-side rate limiter that proactively
  slows outbound requests when it sees throttling) + a higher `maxAttempts`.
- A `withTransientRetry` wrapper retries **only** the typed
  `ObjectStorageTransientError`; NotFound/Access/InvalidPath pass through
  immediately. The upload op must recreate the `fs` read stream + `Upload` each
  round — a consumed stream can't be replayed.

**Why classify inside the op:** `withTransientRetry` branches on the typed
hierarchy, so each op must call `classifyS3Error()` before throwing.

**Known residual risk:** because upload is synchronous, a *sustained* storm can
push handler latency past the nginx/proxy timeout (504). The real fix for that is
to move upload/verify off the request path (accept + persist intent, upload in a
worker). Tunables: `HETZNER_S3_MAX_ATTEMPTS`, `HETZNER_S3_RETRY_ROUNDS`,
`HETZNER_S3_RETRY_BASE_MS`, `HETZNER_S3_RETRY_MAX_MS`.
