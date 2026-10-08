// Static render checks for the wizard's AI preheader helper (react-dom/server,
// no DOM): the idle button states and the suggestion list with a selected
// entry, a long entry flagged amber and server notes.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreheaderSuggestionList, PreheaderSuggestions } from "../client/src/components/campaign-wizard/preheader-suggestions";
import type { PreheaderSuggestionsResponse } from "../shared/preheader-suggestions";

const result: PreheaderSuggestionsResponse = {
  model: "claude-sonnet-4-5",
  language: "fr",
  notes: ["Newsletter longue : seule la première partie du texte a été analysée."],
  suggestions: [
    { text: "Réservez avant le 20 octobre et profitez de 4 nuits minimum", angle: "urgence" },
    { text: "Aqua Mundo à 29°, accrobranche et cottages avec cheminée", angle: "détail de l'offre" },
    { text: `Une proposition beaucoup trop longue ${"qui déborde ".repeat(8)}du cadre`, angle: null },
  ],
};

describe("PreheaderSuggestions (wizard button)", () => {
  it("is disabled until the newsletter HTML is loaded", () => {
    const html = renderToStaticMarkup(createElement(PreheaderSuggestions, {
      subject: "Objet", htmlContent: "   ", value: "", onSelect: () => {},
    }));
    expect(html).toContain("Proposer avec l&#x27;IA");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="button-preheader-suggest"/);
    expect(html).not.toContain('data-testid="preheader-suggestions-list"');
  });

  it("is enabled once HTML is present", () => {
    const html = renderToStaticMarkup(createElement(PreheaderSuggestions, {
      subject: "Objet", htmlContent: "<p>Bonjour</p>", value: "", onSelect: () => {},
    }));
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="button-preheader-suggest"/);
  });
});

describe("PreheaderSuggestionList", () => {
  it("renders every suggestion with its length, marks the one in use and shows notes", () => {
    const html = renderToStaticMarkup(createElement(PreheaderSuggestionList, {
      result, value: result.suggestions[1].text, onSelect: () => {},
    }));
    expect(html).toContain("Langue détectée : FR.");
    expect(html).toContain("Réservez avant le 20 octobre");
    expect(html).toContain("urgence");
    expect(html).toContain(`${result.suggestions[0].text.length} caractères`);
    // The selected entry is the only pressed one.
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/data-testid="button-preheader-suggestion-1"[^>]*>/);
    // Long entry gets the amber length tone.
    expect(html).toContain("text-amber-600");
    expect(html).toContain("seule la première partie du texte a été analysée");
  });
});
