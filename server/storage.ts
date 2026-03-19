/**
 * Thin storage aggregator — delegates to focused repository modules.
 * Each repository owns its domain; this file is the single `storage` export
 * consumed by route handlers and services.
 */
import type { IStorage } from "./storage-interface";

import * as subscriberRepo from "./repositories/subscriber-repository";
import * as campaignRepo from "./repositories/campaign-repository";
import * as importRepo from "./repositories/import-repository";
import * as mtaRepo from "./repositories/mta-repository";
import * as jobRepo from "./repositories/job-repository";
import * as systemRepo from "./repositories/system-repository";

export const storage: IStorage = {
  // ── Subscribers ───────────────────────────────────────────────
  ...subscriberRepo,

  // ── Campaigns + sends + nullsink + dashboard analytics ────────
  ...campaignRepo,

  // ── Import jobs + queue + refs ────────────────────────────────
  ...importRepo,

  // ── MTAs + email headers ──────────────────────────────────────
  ...mtaRepo,

  // ── Campaign jobs + flush + error logs ────────────────────────
  ...jobRepo,

  // ── Users + maintenance + healthCheck + campaign analytics ────
  ...systemRepo,
} as unknown as IStorage;
