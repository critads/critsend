import { describe, expect, it } from "vitest";
import {
  PREHEADER_TEXT_BUDGET_CHARS,
  PreheaderSuggestionError,
  buildPreheaderPrompt,
  extractNewsletterText,
  parsePreheaderModelOutput,
  suggestPreheaders,
} from "../server/services/preheader-suggestions";
import { PREHEADER_MAX_LENGTH, PREHEADER_SUGGESTION_COUNT } from "../shared/preheader-suggestions";

const NEWSLETTER = `<!doctype html><html><head><title>Soldes Mobilier de France</title>
<style>.x{color:red}</style><script>track()</script></head>
<body>
<div style="display:none;max-height:0;overflow:hidden;">Jusqu'à -40% sur les canapés jusqu'au 15 octobre</div>
<table><tr><td><img src="hero.jpg" alt="Canapé d'angle Oslo en tissu gris" width="600"></td></tr>
<tr><td><h1>Les soldes d'automne commencent</h1><p>Profitez de -40% sur une sélection de canapés et fauteuils.</p>
<a href="https://x/shop">Découvrir la collection</a></td></tr></table>
<img src="pixel.gif" width="1" height="1" alt="">
<p style="font-size:10px">Se désabonner | Voir la version en ligne</p>
</body></html>`;

describe("extractNewsletterText", () => {
  it("keeps the visible copy, title and image alt texts, drops scripts/styles/pixels", () => {
    const extracted = extractNewsletterText(NEWSLETTER);
    expect(extracted.text).toContain("Titre : Soldes Mobilier de France");
    expect(extracted.text).toContain("Les soldes d'automne commencent");
    expect(extracted.text).toContain("[image : Canapé d'angle Oslo en tissu gris]");
    expect(extracted.text).toContain("Découvrir la collection");
    expect(extracted.text).not.toContain("track()");
    expect(extracted.text).not.toContain("color:red");
    expect(extracted.truncated).toBe(false);
  });

  it("surfaces the hidden preview block separately instead of mixing it with the body", () => {
    const extracted = extractNewsletterText(NEWSLETTER);
    expect(extracted.existingPreheader).toBe("Jusqu'à -40% sur les canapés jusqu'au 15 octobre");
    expect(extracted.text).not.toContain("jusqu'au 15 octobre");
  });

  it("truncates long newsletters to the text budget and says so", () => {
    const long = `<body>${"<p>Un paragraphe de newsletter assez long pour compter.</p>".repeat(1_000)}</body>`;
    const extracted = extractNewsletterText(long);
    expect(extracted.truncated).toBe(true);
    expect(extracted.text.length).toBeLessThanOrEqual(PREHEADER_TEXT_BUDGET_CHARS + 40);
    expect(extracted.text.endsWith("[… contenu tronqué]")).toBe(true);
  });
});

describe("buildPreheaderPrompt", () => {
  it("passes subject, campaign, existing preheader and visible text, asks for JSON", () => {
    const request = buildPreheaderPrompt(
      { subject: "Soldes : -40% sur les canapés", htmlContent: NEWSLETTER, campaignName: "#3681 Mobilier de France" },
      extractNewsletterText(NEWSLETTER),
    );
    expect(request.system).toContain(`${PREHEADER_SUGGESTION_COUNT} preheaders`);
    expect(request.system).toContain('"suggestions"');
    expect(request.user).toContain("Campagne : #3681 Mobilier de France");
    expect(request.user).toContain("Objet : Soldes : -40% sur les canapés");
    expect(request.user).toContain("Preheader déjà présent dans le template");
    expect(request.user).toContain("Les soldes d'automne commencent");
    expect(request.maxTokens).toBeGreaterThan(0);
  });
});

describe("parsePreheaderModelOutput", () => {
  it("accepts fenced JSON, trims, strips quotes/numbering, dedupes and drops the subject copy", () => {
    const answer = "```json\n" + JSON.stringify({
      language: "FR",
      suggestions: [
        { text: "  « Canapés et fauteuils à -40 %, livraison offerte dès 500 € »  ", angle: " Bénéfice " },
        { text: "1. Canapés et fauteuils à -40 %, livraison offerte dès 500 €", angle: "doublon" },
        { text: "Soldes : -40% sur les canapés", angle: "copie de l'objet" },
        { text: "Le canapé Oslo, star de la collection, enfin en promotion", angle: "curiosité" },
        { text: "Plus que quelques jours pour en profiter en magasin et en ligne" },
        { text: "Découvrez la sélection complète avant la fin des soldes", angle: "offre" },
        { text: "Cinquième proposition retenue une fois les rejets écartés", angle: "preuve" },
        { text: "Sixième proposition, au-delà du quota, jamais affichée", angle: "trop" },
      ],
    }) + "\n```";
    const { suggestions, language } = parsePreheaderModelOutput(answer, "Soldes : -40% sur les canapés");
    expect(language).toBe("fr");
    expect(suggestions.map((s) => s.text)).toEqual([
      "Canapés et fauteuils à -40 %, livraison offerte dès 500 €",
      "Le canapé Oslo, star de la collection, enfin en promotion",
      "Plus que quelques jours pour en profiter en magasin et en ligne",
      "Découvrez la sélection complète avant la fin des soldes",
      "Cinquième proposition retenue une fois les rejets écartés",
    ]);
    expect(suggestions[0].angle).toBe("bénéfice");
    expect(suggestions[2].angle).toBeNull();
    expect(suggestions.length).toBeLessThanOrEqual(PREHEADER_SUGGESTION_COUNT);
  });

  it("caps over-long lines at a word boundary", () => {
    const longText = `${"Canapé ".repeat(40)}fin`;
    const { suggestions } = parsePreheaderModelOutput(
      JSON.stringify({ suggestions: [longText, "Deuxième proposition correcte et assez longue", "Troisième proposition correcte et assez longue"] }),
      "",
    );
    expect(suggestions[0].text.length).toBeLessThanOrEqual(PREHEADER_MAX_LENGTH);
    expect(suggestions[0].text.endsWith("Canapé")).toBe(true);
  });

  it("rejects answers with fewer than three usable suggestions", () => {
    expect(() => parsePreheaderModelOutput(JSON.stringify({ suggestions: ["Une seule", "Une seule"] }), ""))
      .toThrow(/exploitable/);
    expect(() => parsePreheaderModelOutput("Désolé, je ne peux pas.", "")).toThrow(/JSON/);
  });
});

describe("suggestPreheaders", () => {
  const modelAnswer = JSON.stringify({
    language: "fr",
    suggestions: [
      { text: "Canapés et fauteuils à -40 %, en magasin comme en ligne", angle: "offre" },
      { text: "Le canapé d'angle Oslo enfin à prix soldé", angle: "produit" },
      { text: "Les soldes d'automne commencent : notre sélection", angle: "curiosité" },
      { text: "Une occasion de refaire le salon sans attendre les fêtes", angle: "bénéfice" },
      { text: "Découvrez la collection avant que les stocks ne partent", angle: "urgence" },
    ],
  });

  it("returns the normalised suggestions with the model name and no notes for a short newsletter", async () => {
    const calls: string[] = [];
    const result = await suggestPreheaders(
      { subject: "Soldes : -40% sur les canapés", htmlContent: NEWSLETTER },
      {
        model: "test-model",
        callModel: async (request) => {
          calls.push(request.user);
          return { text: modelAnswer, model: "test-model-2026", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 20 } };
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(result.suggestions).toHaveLength(5);
    expect(result.model).toBe("test-model-2026");
    expect(result.language).toBe("fr");
    expect(result.notes).toEqual([]);
  });

  it("refuses HTML without readable text before calling the model", async () => {
    let called = false;
    await expect(suggestPreheaders(
      { subject: "x", htmlContent: "<html><body><img src='a.png'></body></html>" },
      { model: "m", callModel: async () => { called = true; return { text: modelAnswer, model: "m", stopReason: null, usage: null }; } },
    )).rejects.toMatchObject({ code: "CONTENT_EMPTY", status: 422 });
    expect(called).toBe(false);
  });

  it("maps a model answer without JSON to AI_BAD_RESPONSE (502)", async () => {
    await expect(suggestPreheaders(
      { subject: "x", htmlContent: NEWSLETTER },
      { model: "m", callModel: async () => ({ text: "Je ne peux pas répondre.", model: "m", stopReason: null, usage: null }) },
    )).rejects.toBeInstanceOf(PreheaderSuggestionError);
    await expect(suggestPreheaders(
      { subject: "x", htmlContent: NEWSLETTER },
      { model: "m", callModel: async () => ({ text: "Je ne peux pas répondre.", model: "m", stopReason: null, usage: null }) },
    )).rejects.toMatchObject({ code: "AI_BAD_RESPONSE", status: 502 });
  });
});
