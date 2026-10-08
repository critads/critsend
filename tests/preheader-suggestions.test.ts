import { describe, expect, it } from "vitest";
import {
  PREHEADER_MAX_IMAGES,
  PREHEADER_TEXT_BUDGET_CHARS,
  PreheaderSuggestionError,
  buildPreheaderPrompt,
  collectImageCandidates,
  decodeImageHeader,
  extractNewsletterText,
  parsePreheaderModelOutput,
  prepareNewsletterImages,
  suggestPreheaders,
  type ImageCandidate,
} from "../server/services/preheader-suggestions";
import { buildUserContent } from "../server/services/anthropic-client";
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

  it("keeps MJML font-size:0 wrappers (they are visible) and reads desktop/mobile duplicates once", () => {
    const mjml = `<body>
      <div style="font-size:0px;text-align:left;direction:ltr;vertical-align:top;width:100%;">
        <table style="font-size:0px;padding:0px;word-break:break-word;"><tr><td style="font-size:0px;">
          <p>JUSQU'A -50% sur la ligne Allure</p>
        </td></tr></table>
      </div>
      <div style="display:none; font-size:0; text-align:left; direction:ltr; vertical-align:top; width:100%">
        <p>JUSQU'A -50% sur la ligne Allure</p><p>Version mobile : offre valable jusqu'au 20 octobre</p>
      </div>
    </body>`;
    const extracted = extractNewsletterText(mjml);
    expect(extracted.text).toContain("JUSQU'A -50% sur la ligne Allure");
    expect(extracted.text.match(/JUSQU'A -50%/g)).toHaveLength(1);
    expect(extracted.text).toContain("Version mobile : offre valable jusqu'au 20 octobre");
    // A hidden block that does not open the newsletter is content, not the preheader.
    expect(extracted.existingPreheader).toBeNull();
  });

  it("truncates long newsletters to the text budget and says so", () => {
    const long = `<body>${Array.from({ length: 1_000 }, (_, i) => `<p>Paragraphe ${i} : un bloc de newsletter assez long pour compter.</p>`).join("")}</body>`;
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
    expect(request.images).toBeUndefined();
    expect(buildUserContent(request)).toBe(request.user);
  });

  it("attaches the newsletter images before the text, each with its caption", () => {
    const images = [
      { mediaType: "image/png" as const, data: "AAAA", label: "Image 1 de la newsletter (alt : KV) :" },
      { mediaType: "image/jpeg" as const, data: "BBBB" },
    ];
    const request = buildPreheaderPrompt({ subject: "x", htmlContent: NEWSLETTER }, extractNewsletterText(NEWSLETTER), images);
    expect(request.user).toContain("2 image(s) de la newsletter sont jointes");
    expect(request.system).toContain("lis le texte qu'elles contiennent");
    const content = buildUserContent(request) as Array<{ type: string; text?: string; source?: { media_type: string; data: string } }>;
    expect(content.map((block) => block.type)).toEqual(["text", "image", "image", "text"]);
    expect(content[0].text).toBe("Image 1 de la newsletter (alt : KV) :");
    expect(content[1].source).toEqual({ type: "base64", media_type: "image/png", data: "AAAA" });
    expect(content[3].text).toBe(request.user);
  });
});

const PNG_HEADER = (width: number, height: number) => {
  const buffer = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

describe("newsletter images", () => {
  it("collects unique images in order, skipping pixels, tiny icons and data URIs, capped", () => {
    const html = `<body>
      <img src="https://cdn/logo.png" alt="SIMONE PERELE" width="363">
      <img src="https://cdn/kv.png" alt="kv1" width="213">
      <img src="https://cdn/kv.png" alt="KV1 again" width="303">
      <img src="https://impfr.tradedoubler.com/imp?type(img)g(1)a(2)" alt="">
      <img src="https://cdn/pixel.gif" width="1" height="1">
      <img src="https://cdn/icon.png" width="24" height="24" alt="icon">
      <img src="https://cdn/styled.jpg" style="width:600px;height:300px" alt="styled">
      <img src="data:image/png;base64,AAAA">
      ${Array.from({ length: 10 }, (_, i) => `<img src="https://cdn/more-${i}.jpg" width="600">`).join("")}
    </body>`;
    const candidates = collectImageCandidates(html);
    expect(candidates).toHaveLength(PREHEADER_MAX_IMAGES);
    expect(candidates.slice(0, 3).map((c) => [c.index, c.src, c.alt, c.width, c.height])).toEqual([
      [1, "https://cdn/logo.png", "SIMONE PERELE", 363, null],
      [2, "https://cdn/kv.png", "kv1", 213, null],
      [3, "https://cdn/styled.jpg", "styled", 600, 300],
    ]);
    expect(candidates.some((c) => c.src.includes("tradedoubler") || c.src.includes("pixel") || c.src.includes("icon"))).toBe(false);
  });

  it("recognises PNG, JPEG, GIF and WebP headers and refuses anything else", () => {
    expect(decodeImageHeader(PNG_HEADER(600, 400))).toEqual({ mediaType: "image/png", width: 600, height: 400 });
    const gif = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from([0x58, 0x02, 0x90, 0x01, 0, 0, 0, 0])]);
    expect(decodeImageHeader(gif)).toEqual({ mediaType: "image/gif", width: 600, height: 400 });
    // JPEG: SOI, APP0 (length 16), SOF0 with height 400 / width 600.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x58, 0x03]), Buffer.alloc(16),
    ]);
    expect(decodeImageHeader(jpeg)).toEqual({ mediaType: "image/jpeg", width: 600, height: 400 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii"); webp.write("WEBP", 8, "ascii"); webp.write("VP8X", 12, "ascii");
    webp.writeUIntLE(599, 24, 3); webp.writeUIntLE(399, 27, 3);
    expect(decodeImageHeader(webp)).toEqual({ mediaType: "image/webp", width: 600, height: 400 });
    expect(decodeImageHeader(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(decodeImageHeader(Buffer.from("BM" + "x".repeat(40)))).toBeNull();
  });

  it("turns fetched images into vision inputs, skipping failures, tiny and non-raster files, under one deadline", async () => {
    const candidates: ImageCandidate[] = [
      { index: 1, src: "https://cdn/a.png", alt: "KV", width: 600, height: null },
      { index: 2, src: "https://cdn/b.png", alt: null, width: null, height: null },
      { index: 3, src: "https://cdn/c.svg", alt: "logo", width: 200, height: null },
      { index: 4, src: "https://cdn/d.png", alt: "spacer", width: null, height: null },
      { index: 5, src: "https://cdn/e.png", alt: "late", width: 600, height: null },
    ];
    let clock = 1_000;
    const fetched: string[] = [];
    const prepared = await prepareNewsletterImages(candidates, async (candidate) => {
      fetched.push(candidate.src);
      if (candidate.src.endsWith("b.png")) return null;
      if (candidate.src.endsWith("c.svg")) return Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
      if (candidate.src.endsWith("d.png")) return PNG_HEADER(20, 20);
      if (candidate.src.endsWith("a.png")) { clock = 10_000; }
      return PNG_HEADER(600, 400);
    }, 5_000, () => clock);
    expect(prepared.candidates).toBe(5);
    expect(prepared.images.map((image) => image.label)).toEqual(["Image 1 de la newsletter (alt : KV) :"]);
    expect(prepared.images[0].mediaType).toBe("image/png");
    expect(prepared.images[0].data).toBe(PNG_HEADER(600, 400).toString("base64"));
    expect(prepared.skipped).toBe(4);
    // The 5th candidate was never attempted: the first four started together and the clock was past the deadline by then.
    expect(fetched).not.toContain("https://cdn/e.png");
    expect(prepared.timedOut).toBe(true);
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

  it("shows the newsletter images to the model and returns the normalised suggestions", async () => {
    const calls: Array<{ user: string; images: number; timeoutMs: number }> = [];
    const result = await suggestPreheaders(
      { subject: "Soldes : -40% sur les canapés", htmlContent: NEWSLETTER },
      {
        model: "test-model",
        fetchImage: async () => PNG_HEADER(600, 400),
        callModel: async (request, timeoutMs) => {
          calls.push({ user: request.user, images: request.images?.length ?? 0, timeoutMs });
          return { text: modelAnswer, model: "test-model-2026", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 20 } };
        },
      },
    );
    expect(calls).toHaveLength(1);
    // hero.jpg only: the 1×1 pixel is filtered out before any fetch.
    expect(calls[0].images).toBe(1);
    expect(calls[0].timeoutMs).toBeGreaterThanOrEqual(20_000);
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(55_000);
    expect(result.suggestions).toHaveLength(5);
    expect(result.model).toBe("test-model-2026");
    expect(result.language).toBe("fr");
    expect(result.imagesAnalyzed).toBe(1);
    expect(result.notes).toEqual([]);
  });

  it("works on a picture-only newsletter when at least one image loads", async () => {
    const pictureOnly = `<body><img src="https://cdn/kv1.png" alt="kv1" width="600"><img src="https://cdn/kv2.png" alt="kv2" width="600"></body>`;
    let seenImages = 0;
    const result = await suggestPreheaders(
      { subject: "Simone Days, jusqu'à -50% !", htmlContent: pictureOnly },
      {
        model: "m",
        fetchImage: async (candidate) => (candidate.index === 1 ? PNG_HEADER(600, 800) : null),
        callModel: async (request) => {
          seenImages = request.images?.length ?? 0;
          expect(request.user).toContain("[image : kv1]");
          expect(request.user).toContain("(aucun texte : tout le contenu est dans les images)");
          return { text: modelAnswer, model: "m", stopReason: null, usage: null };
        },
      },
    );
    expect(seenImages).toBe(1);
    expect(result.imagesAnalyzed).toBe(1);
    expect(result.notes).toEqual(["1 image(s) sur 2 non analysée(s)."]);
  });

  it("falls back to the text with a note when no image can be loaded", async () => {
    const result = await suggestPreheaders(
      { subject: "x", htmlContent: NEWSLETTER },
      {
        model: "m",
        fetchImage: async () => null,
        callModel: async (request) => {
          expect(request.images).toBeUndefined();
          return { text: modelAnswer, model: "m", stopReason: null, usage: null };
        },
      },
    );
    expect(result.imagesAnalyzed).toBe(0);
    expect(result.notes).toEqual(["Aucune des 1 image(s) n'a pu être analysée : propositions basées sur le texte seul."]);
  });

  it("refuses a picture-only newsletter whose images all fail to load, without calling the model", async () => {
    let called = false;
    await expect(suggestPreheaders(
      { subject: "x", htmlContent: "<body><img src='https://cdn/kv.png' width='600'></body>" },
      { model: "m", fetchImage: async () => null, callModel: async () => { called = true; return { text: modelAnswer, model: "m", stopReason: null, usage: null }; } },
    )).rejects.toMatchObject({ code: "CONTENT_EMPTY", status: 422 });
    expect(called).toBe(false);
  });

  it("refuses HTML with neither readable text nor images before calling the model", async () => {
    let called = false;
    await expect(suggestPreheaders(
      { subject: "x", htmlContent: "<html><body><img src='https://cdn/pixel.gif' width='1' height='1'><p>ok</p></body></html>" },
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
