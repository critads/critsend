import { describe, expect, it } from "vitest";
import {
  removeExternalImageElements,
  updateManagedCampaignNameMtaSuffix,
  updateCampaignNameMtaSuffix,
} from "../client/src/lib/campaign-wizard";

describe("removeExternalImageElements", () => {
  const ourHosts = new Set(["images.mta.example"]);

  it("removes only image elements hosted outside the selected MTA domains", () => {
    const html = [
      '<img src="https://blocked.example/hero.jpg" alt="hero">',
      '<img src="https://images.mta.example/logo.png" alt="logo">',
      '<img src="/campaigns/local/banner.png" alt="local">',
      '<img src="data:image/png;base64,abc" alt="inline">',
      '<iframe src="https://blocked.example/frame"></iframe>',
    ].join("");

    const result = removeExternalImageElements(html, ourHosts);

    expect(result.removed).toBe(1);
    expect(result.html).not.toContain("hero.jpg");
    expect(result.html).toContain("images.mta.example/logo.png");
    expect(result.html).toContain("/campaigns/local/banner.png");
    expect(result.html).toContain("data:image/png;base64,abc");
    expect(result.html).toContain("blocked.example/frame");
  });

  it("supports single-quoted and unquoted src attributes plus picture sources", () => {
    const html = [
      "<picture>",
      "<source src='https://blocked.example/mobile.webp'>",
      "<img src=https://blocked.example/fallback.jpg>",
      "</picture>",
    ].join("");

    const result = removeExternalImageElements(html, ourHosts);

    expect(result.removed).toBe(2);
    expect(result.html).toBe("<picture></picture>");
  });

  it("leaves HTML unchanged when no image is blocked", () => {
    const html = '<img src="https://images.mta.example/ok.jpg"><p>Content</p>';

    expect(removeExternalImageElements(html, ourHosts)).toEqual({
      html,
      removed: 0,
    });
  });
});

describe("updateCampaignNameMtaSuffix", () => {
  const mtas = [
    { name: "Mayesale.com", hostname: "mayesale.com" },
    { name: "Rndaserver.com", hostname: "rndaserver.com" },
    { name: "Kammaspeed.com", hostname: "kammaspeed.com" },
  ];

  it("replaces a configured MTA suffix when the selected MTA changes", () => {
    expect(updateCampaignNameMtaSuffix(
      "#3124 Ricaud - 3ceR1H - mayesale",
      mtas[1],
      mtas,
    )).toBe("#3124 Ricaud - 3ceR1H - Rndaserver.com");
  });

  it("recognizes a shortened MTA suffix used in historical campaign names", () => {
    expect(updateCampaignNameMtaSuffix(
      "#3130 Comme j'aime - 5cn4YY - kamma",
      mtas[1],
      mtas,
    )).toBe("#3130 Comme j'aime - 5cn4YY - Rndaserver.com");
  });

  it("keeps the new-campaign append behavior unchanged", () => {
    expect(updateCampaignNameMtaSuffix(
      "#3130 Comme j'aime - 5cn4YY",
      mtas[2],
      mtas,
    )).toBe("#3130 Comme j'aime - 5cn4YY - Kammaspeed.com");
  });

  it("does not create a name from an empty field", () => {
    expect(updateCampaignNameMtaSuffix("", mtas[0], mtas)).toBe("");
  });

  it("replaces the generated suffix repeatedly while editing a copied campaign", () => {
    const firstChange = updateManagedCampaignNameMtaSuffix(
      "#3124 Ricaud - 3ceR1H - mayesale",
      mtas[1],
      mtas,
      false,
    );
    const secondChange = updateManagedCampaignNameMtaSuffix(
      firstChange,
      mtas[2],
      mtas,
      false,
    );

    expect(firstChange).toBe("#3124 Ricaud - 3ceR1H - Rndaserver.com");
    expect(secondChange).toBe("#3124 Ricaud - 3ceR1H - Kammaspeed.com");
  });

  it("does not append an MTA to an editor name without a recognized suffix", () => {
    expect(updateManagedCampaignNameMtaSuffix(
      "#3130 Comme j'aime - 5cn4YY",
      mtas[2],
      mtas,
      false,
    )).toBe("#3130 Comme j'aime - 5cn4YY");
  });

  it("preserves a manually edited campaign name across MTA changes", () => {
    const customName = "#3124 Ricaud - custom operator name - mayesale";

    expect(updateManagedCampaignNameMtaSuffix(
      customName,
      mtas[1],
      mtas,
      true,
    )).toBe(customName);
  });
});