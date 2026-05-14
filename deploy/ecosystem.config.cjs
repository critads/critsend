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
  ],
};
