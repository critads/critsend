import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repositorySource = readFileSync(
  new URL("../server/repositories/system-repository.ts", import.meta.url),
  "utf8",
);
const analyticsSource = readFileSync(
  new URL("../client/src/pages/analytics.tsx", import.meta.url),
  "utf8",
);

describe("campaign provider complaint analytics", () => {
  it("counts unique complaint detections for both historical event shapes", () => {
    expect(repositorySource).toContain("st.ip_address = '195.154.17.225'");
    expect(repositorySource).toContain("st.type IN ('open', 'complaint')");
    expect(repositorySource).toContain("COUNT(DISTINCT CASE");
    expect(repositorySource).toContain("AS complaints");
  });

  it("calculates complaint rate against provider recipients", () => {
    expect(repositorySource).toContain("Number(r.complaints) / Number(r.recipients)");
    expect(repositorySource).toContain("complaintRate:");
  });

  it("renders complaint count and rate columns", () => {
    expect(analyticsSource).toContain(">Complaints<");
    expect(analyticsSource).toContain(">Complaint Rate<");
    expect(analyticsSource).toContain("row.complaints.toLocaleString()");
    expect(analyticsSource).toContain("row.complaintRate.toFixed(2)");
  });
});