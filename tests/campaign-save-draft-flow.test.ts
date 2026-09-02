import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("campaign draft save flow", () => {
  it("waits for persistence before leaving the wizard and surfaces failures", () => {
    const source = readFileSync("client/src/pages/campaign-new.tsx", "utf8");
    const handler = source.slice(
      source.indexOf("const handleSaveDraft = async"),
      source.indexOf("const isReadyToSend"),
    );

    expect(handler).toContain("await saveDraftMutation.mutateAsync(formData)");
    expect(handler.indexOf("await saveDraftMutation.mutateAsync(formData)"))
      .toBeLessThan(handler.indexOf('navigate("/campaigns")'));
    expect(source).toContain('title: "Draft not saved"');
  });
});