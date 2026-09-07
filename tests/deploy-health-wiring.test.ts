import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deploySource = readFileSync("deploy/deploy.sh", "utf8");
const ecosystemSource = readFileSync("deploy/ecosystem.config.cjs", "utf8");
const serverSource = readFileSync("server/index.ts", "utf8");
const githubDeploySource = readFileSync(
  "deploy/github-actions-deploy.yml",
  "utf8",
);

const immediateHealthSection = deploySource.slice(
  deploySource.indexOf("# ─── Step 8: Immediate health confirmation"),
  deploySource.indexOf("# ─── Step 9: Post-deploy fatal-error probe"),
);

describe("deployment readiness wiring", () => {
  it("uses PM2 readiness as the blocking web startup gate", () => {
    expect(ecosystemSource).toContain("wait_ready: true");
    expect(ecosystemSource).toContain("listen_timeout: 120000");
    expect(serverSource).toContain('process.send("ready")');

    const startupCompleteIndex = serverSource.indexOf("startupComplete = true");
    const pm2ReadyIndex = serverSource.indexOf('process.send("ready")');
    expect(startupCompleteIndex).toBeGreaterThan(-1);
    expect(pm2ReadyIndex).toBeGreaterThan(startupCompleteIndex);
  });

  it("performs one immediate local health request without a retry sleep", () => {
    expect(immediateHealthSection).toContain(
      "Confirming app health after PM2 readiness",
    );
    expect(immediateHealthSection.match(/\bcurl\b/g)).toHaveLength(1);
    expect(immediateHealthSection).toContain("%{http_code}");
    expect(immediateHealthSection).not.toMatch(/\bsleep\s+\d+/);
    expect(immediateHealthSection).not.toContain("seq 1 20");
    expect(immediateHealthSection).not.toContain("Health endpoint did not respond within 60s");
  });

  it("retains diagnostics and rejects non-online web instances", () => {
    const clusterCheckIndex = immediateHealthSection.indexOf(
      'PM2_WEB_CHECK="$(node -e',
    );
    const finalHealthDecisionIndex = immediateHealthSection.indexOf(
      'if [ "$HEALTH_READY" = "true" ]',
    );

    expect(clusterCheckIndex).toBeGreaterThan(-1);
    expect(finalHealthDecisionIndex).toBeGreaterThan(clusterCheckIndex);
    expect(immediateHealthSection).toContain(
      "statuses.length === expected",
    );
    expect(immediateHealthSection).toContain(
      'statuses.every(status => status === "online")',
    );
    expect(immediateHealthSection).toContain(
      'PM2_ALL_ONLINE" = "yes"',
    );
    expect(immediateHealthSection).toContain(
      "critsend-web instances:",
    );
    expect(immediateHealthSection).toContain(
      "/var/log/critsend/web-err.log",
    );
    expect(immediateHealthSection).toContain(
      "/var/log/critsend/web-out.log",
    );
    expect(immediateHealthSection).toContain(
      "online web instances",
    );
  });

  it("keeps the separate public health check and bootstrap safety delay", () => {
    expect(githubDeploySource).toContain("${{ secrets.APP_URL }}/api/health");
    expect(githubDeploySource).toContain("for i in $(seq 1 6)");
    expect(deploySource).toContain(
      "Waiting 25s for web bootstrap to finish",
    );
    expect(deploySource).toContain("sleep 25");
  });
});