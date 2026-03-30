/**
 * PM2 Ecosystem Config — Critsend
 *
 * Starts two isolated processes:
 *   critsend-web    — HTTP server, SSE, API  (PROCESS_TYPE=web)
 *   critsend-worker — Background job engine  (PROCESS_TYPE=worker)
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
      script: "node_modules/.bin/tsx",
      args: "server/index.ts",

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
      script: "node_modules/.bin/tsx",
      args: "server/worker-main.ts",

      // Load secrets and runtime config from the .env file at the repo root
      env_file: ".env",

      // Production-specific overrides
      env_production: {
        NODE_ENV: "production",
        PROCESS_TYPE: "worker",
        NODE_OPTIONS: "--max-old-space-size=4096 --expose-gc",
      },

      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: "10s",

      out_file: "/var/log/critsend/worker-out.log",
      error_file: "/var/log/critsend/worker-err.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      max_memory_restart: "2G",
      kill_timeout: 30000,
    },
  ],
};
