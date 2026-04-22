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
 * Environment variables are loaded from .env (repo root).
 * Set all [REQUIRED] vars there before first deploy — see .env.example.
 */

"use strict";

module.exports = {
  apps: [
    {
      name: "critsend-web",
      script: "dist/index.cjs",
      cwd: "/home/ubuntu/critsend",

      // Load secrets and runtime config from the .env file at the repo root
      env_file: ".env",

      // Production-specific overrides (applied on top of .env when --env production)
      env_production: {
        NODE_ENV: "production",
        PROCESS_TYPE: "web",
        NODE_OPTIONS: "--max-old-space-size=4096 --expose-gc",
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

      // Load secrets and runtime config from the .env file at the repo root
      env_file: ".env",

      // Production-specific overrides
      env_production: {
        NODE_ENV: "production",
        PROCESS_TYPE: "worker",
        NODE_OPTIONS: "--max-old-space-size=6144 --expose-gc",
        // Sized for ≥1.5× MAX_CONCURRENT_CAMPAIGNS. With campaign-sender now
        // serializing prefetch + finalize, each in-flight campaign holds at
        // most 1 main-pool conn at a time, so 18 slots comfortably cover
        // 12 concurrent campaigns + tag queue + maintenance + heartbeats.
        WORKER_PG_POOL_MAX: "18",
        MAX_CONCURRENT_CAMPAIGNS: "8",
      },

      // Raised from 10 → 50 so PM2 doesn't give up after a burst of memory-triggered
      // restarts during large imports (GIN index recreation uses significant RAM).
      max_restarts: 50,
      // 5-second pause between restarts to avoid rapid crash loops burning the restart budget.
      restart_delay: 5000,
      min_uptime: "10s",

      out_file: "/var/log/critsend/worker-out.log",
      error_file: "/var/log/critsend/worker-err.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // Raised from 2G → 4G — large imports (376k+ rows) with GIN index recreation
      // can use well over 2 GB; frequent memory-restarts deplete the restart budget.
      max_memory_restart: "4G",
      kill_timeout: 30000,
    },
  ],
};
