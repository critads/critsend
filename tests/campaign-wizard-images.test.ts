import { describe, expect, it } from "vitest";
import { removeExternalImageElements } from "../client/src/lib/campaign-wizard";

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