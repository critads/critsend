/**
 * PM2 Ecosystem Config — Critsend
 *
 * Starts two isolated processes from compiled production artifacts (dist/):
 *   critsend-web    — HTTP server, SSE, API        (dist/index.cjs)
 *   critsend-worker — Background job engine         (dist/worker-main.cjs)
 *
 * Prerequisites: run `npm run build` before starting PM2 (deploy.sh does this).
 *
 * Usage:
 *   pm2 start deploy/ecosystem.config.cjs --env production
 *   pm2 reload deploy/ecosystem.config.cjs --env production   # zero-downtime reload
 *   pm2 save                                                  # persist across reboots
 *   pm2 startup                                               # generate systemd service
 *
 * Environment variables are loaded from .env (repo root) via the loadEnvFile()
 * helper below. PM2 does NOT natively support env_file, so we parse .env
 * ourselves and merge into env_production.
 */

"use strict";

const fs = require("fs");
const path = require("path");

function loadEnvFile(envPath) {
  try {
    const content = fs.readFileSync(envPath, "utf8");
    const env = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

const dotenvVars = loadEnvFile(path.join(__dirname, "..", ".env"));

module.exports = {
  apps: [
    {
      name: "critsend-web",
      script: "dist/index.cjs",
      cwd: "/home/ubuntu/critsend",

      env_production: {
        ...dotenvVars,
        NODE_ENV: "production",
        PROCESS_TYPE: "web",
        NODE_OPTIONS: "--max-old-space-size=4096 --expose-gc",
        // Persistent upload directories — MUST live outside the app dir so
        // `git pull` / PM2 reload don't wipe queued import CSVs. Provisioned
        // by deploy/setup.sh. Override in .env if needed.
        IMPORT_UPLOAD_DIR: dotenvVars.IMPORT_UPLOAD_DIR || "/var/lib/critsend/uploads/imports",
        IMPORT_CHUNKS_DIR: dotenvVars.IMPORT_CHUNKS_DIR || "/var/lib/critsend/uploads/chunks",
        // Task #153: pressure-guard drain tuning persisted across PM2
        // reloads. The drain runs in BOTH the web (DISABLE_WORKERS branch
        // in server/index.ts) and worker processes — only one acquires the
        // leader lease at a time, so the values must match on both sides.
        // Tuned during the 2026-05-14 prod incident (10+ campaigns launched
        // in parallel on overlapping audiences → 321k due_now backlog) to
        // accelerate drain throughput from ~1.5k to ~25k sends/min while
        // staying within the 50-conn Neon Launch budget. Override in .env
        // if needed; do NOT raise DRAIN_PARALLELISM above 6 without first
        // verifying main-pool headroom (see CONNECTION BUDGET log line).
        PRESSURE_GUARD_POLL_MS: dotenvVars.PRESSURE_GUARD_POLL_MS || "10000",
        PRESSURE_GUARD_BATCH: dotenvVars.PRESSURE_GUARD_BATCH || "1000",
        PRESSURE_GUARD_MAX_CAMPAIGNS: dotenvVars.PRESSURE_GUARD_MAX_CAMPAIGNS || "20",
        PRESSURE_GUARD_DRAIN_PARALLELISM: dotenvVars.PRESSURE_GUARD_DRAIN_PARALLELISM || "4",
        // Task #154: SMTP fan-out concurrency INSIDE drainCampaign. Replaces
        // the strict for-await loop that capped per-campaign throughput at
        // ~10 sends/sec (~600/min). With SMTP_CONCURRENCY=20 × DRAIN_PARALLELISM=4
        // the theoretical ceiling is ~80 simultaneous SMTP sends → ~24k/min
        // cluster-wide, sufficient to drain the 800k+ deferred backlog in <1h.
        PRESSURE_GUARD_SMTP_CONCURRENCY: dotenvVars.PRESSURE_GUARD_SMTP_CONCURRENCY || "20",
        // Task #154: snowball auto-throttle. When a campaign's ratio of
        // currently-deferred / (deferred + sent + failed) exceeds the
        // threshold AND deferred is above the floor, the sender sleeps
        // briefly so the pressure-guard drain can catch up before more
        // contacts are reserved. Defaults match the task contract
        // (threshold 0.5). Set PRESSURE_RATIO_THROTTLE_DISABLED=true to
        // bypass entirely (operator escape hatch).
        PRESSURE_RATIO_THROTTLE_THRESHOLD: dotenvVars.PRESSURE_RATIO_THROTTLE_THRESHOLD || "0.5",
        PRESSURE_RATIO_THROTTLE_MIN_DEFERRED: dotenvVars.PRESSURE_RATIO_THROTTLE_MIN_DEFERRED || "1000",
        PRESSURE_RATIO_THROTTLE_SLEEP_MS: dotenvVars.PRESSURE_RATIO_THROTTLE_SLEEP_MS || "30000",
        PRESSURE_RATIO_THROTTLE_DISABLED: dotenvVars.PRESSURE_RATIO_THROTTLE_DISABLED || "false",
        // Task #160: drain runs in its own PM2 process (critsend-drainer),
        // so the embedded drain in server/index.ts is skipped. The leader
        // lease still keeps things safe even during a partial rollout.
        DRAIN_PROCESS_DEDICATED: dotenvVars.DRAIN_PROCESS_DEDICATED || "true",
      },

      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: "10s",

      out_file: "/var/log/critsend/web-out.log",
      error_file: "/var/log/critsend/web-err.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      max_memory_restart: "2G",
      kill_timeout: 30000,
      wait_ready: false,
      listen_timeout: 30000,
    },
    {
      name: "critsend-worker",
      script: "dist/worker-main.cjs",
      cwd: "/home/ubuntu/critsend",

      env_production: {
        ...dotenvVars,
        NODE_ENV: "production",
        PROCESS_TYPE: "worker",
        NODE_OPTIONS: "--max-old-space-size=6144 --expose-gc",
        WORKER_PG_POOL_MAX: "18",
        MAX_CONCURRENT_CAMPAIGNS: "12",
        MAX_CONNECTIONS_PER_REQUEST: "2",
        // Worker reads CSVs by absolute path stored in import_job_queue, but
        // we set the same env vars here for consistency and so any future
        // worker-side temp writes land on the persistent volume.
        IMPORT_UPLOAD_DIR: dotenvVars.IMPORT_UPLOAD_DIR || "/var/lib/critsend/uploads/imports",
        IMPORT_CHUNKS_DIR: dotenvVars.IMPORT_CHUNKS_DIR || "/var/lib/critsend/uploads/chunks",
        // Task #153: same pressure-guard drain tuning as the web process.
        // The drain leader can be either side; values MUST match.
        PRESSURE_GUARD_POLL_MS: dotenvVars.PRESSURE_GUARD_POLL_MS || "10000",
        PRESSURE_GUARD_BATCH: dotenvVars.PRESSURE_GUARD_BATCH || "1000",
        PRESSURE_GUARD_MAX_CAMPAIGNS: dotenvVars.PRESSURE_GUARD_MAX_CAMPAIGNS || "20",
        PRESSURE_GUARD_DRAIN_PARALLELISM: dotenvVars.PRESSURE_GUARD_DRAIN_PARALLELISM || "4",
        // Task #154: SMTP fan-out concurrency — same value MUST match web side.
        PRESSURE_GUARD_SMTP_CONCURRENCY: dotenvVars.PRESSURE_GUARD_SMTP_CONCURRENCY || "20",
        // Task #154: snowball auto-throttle (same as web side; the
        // sender runs in whichever process owns the campaign job).
        PRESSURE_RATIO_THROTTLE_THRESHOLD: dotenvVars.PRESSURE_RATIO_THROTTLE_THRESHOLD || "0.5",
        PRESSURE_RATIO_THROTTLE_MIN_DEFERRED: dotenvVars.PRESSURE_RATIO_THROTTLE_MIN_DEFERRED || "1000",
        PRESSURE_RATIO_THROTTLE_SLEEP_MS: dotenvVars.PRESSURE_RATIO_THROTTLE_SLEEP_MS || "30000",
        PRESSURE_RATIO_THROTTLE_DISABLED: dotenvVars.PRESSURE_RATIO_THROTTLE_DISABLED || "false",
        // Task #160: same DRAIN_PROCESS_DEDICATED gate as web — both
        // sides must agree, otherwise the worker would race the drainer
        // for the leader lease (it would always lose, but the wasted
        // poll still costs DB calls).
        DRAIN_PROCESS_DEDICATED: dotenvVars.DRAIN_PROCESS_DEDICATED || "true",
      },

      max_restarts: 50,
      restart_delay: 5000,
      min_uptime: "10s",

      out_file: "/var/log/critsend/worker-out.log",
      error_file: "/var/log/critsend/worker-err.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      max_memory_restart: "4G",
      kill_timeout: 30000,
    },
    {
      // Task #160: dedicated pressure-guard drainer process. Isolates
      // the drain from web/worker GC pauses, gives it a tiny dedicated
      // 6-conn DB pool, and crash-restarts in <30s without affecting
      // the rest of the cluster.
      //
      // Pool budget on Neon Launch (50 direct conns):
      //   web (30) + worker (18) + drainer (6) + 2 NOTIFY = 56 → over budget
      //   on paper, but tracking + import use the pooler endpoint (excluded
      //   from the direct count), so actual peak is ~38 direct conns.
      //   See connection-budget.ts logs at startup for the live number.
      name: "critsend-drainer",
      script: "dist/drainer-main.cjs",
      cwd: "/home/ubuntu/critsend",

      env_production: {
        ...dotenvVars,
        NODE_ENV: "production",
        PROCESS_TYPE: "drainer",
        NODE_OPTIONS: "--max-old-space-size=1024 --expose-gc",
        DRAINER_PG_POOL_MAX: dotenvVars.DRAINER_PG_POOL_MAX || "6",
        // Match web/worker drain tuning so the leader-lease handoff is
        // transparent (any process can take leadership and behave the same).
        PRESSURE_GUARD_POLL_MS: dotenvVars.PRESSURE_GUARD_POLL_MS || "10000",
        PRESSURE_GUARD_BATCH: dotenvVars.PRESSURE_GUARD_BATCH || "1000",
        PRESSURE_GUARD_MAX_CAMPAIGNS: dotenvVars.PRESSURE_GUARD_MAX_CAMPAIGNS || "20",
        PRESSURE_GUARD_DRAIN_PARALLELISM: dotenvVars.PRESSURE_GUARD_DRAIN_PARALLELISM || "4",
        PRESSURE_GUARD_SMTP_CONCURRENCY: dotenvVars.PRESSURE_GUARD_SMTP_CONCURRENCY || "20",
      },

      // Aggressive auto-restart — drain liveness is critical, and the
      // process is small enough that a restart storm cannot destabilise
      // the host.
      max_restarts: 100,
      restart_delay: 3000,
      min_uptime: "5s",

      out_file: "/var/log/critsend/drainer-out.log",
      error_file: "/var/log/critsend/drainer-err.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      max_memory_restart: "1G",
      kill_timeout: 30000,
    },
  ],
};
