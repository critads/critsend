// AI preheader suggestions for the campaign wizard (Content step).
//
// Contract shared by the route, the service and the wizard component: the
// browser sends the subject + the newsletter HTML, the server extracts the
// visible text, asks the model for a handful of preheaders and returns them
// already normalised (trimmed, deduplicated, capped). Nothing is persisted:
// the operator picks one and it simply fills the Preheader input.
import { z } from "zod";

/** How many distinct preheaders the operator is shown. */
export const PREHEADER_SUGGESTION_COUNT = 5;
/** Recommended length band (inbox preview text); the model is told to stay inside it. */
export const PREHEADER_RECOMMENDED_MIN = 40;
export const PREHEADER_RECOMMENDED_MAX = 90;
/** Hard cap applied server-side to whatever the model returns. */
export const PREHEADER_MAX_LENGTH = 140;
/** Newsletter HTML larger than this is refused (the wizard already caps uploads well below). */
export const PREHEADER_MAX_HTML_BYTES = 5 * 1024 * 1024;

export const preheaderSuggestionsRequestSchema = z.object({
  subject: z.string().max(500).optional().default(""),
  htmlContent: z.string().min(1, "Le contenu HTML est vide.").max(PREHEADER_MAX_HTML_BYTES),
  campaignName: z.string().max(200).optional(),
});

export type PreheaderSuggestionsRequest = z.infer<typeof preheaderSuggestionsRequestSchema>;

export type PreheaderSuggestion = {
  /** The preheader itself, ready to be used as is. */
  text: string;
  /** Short label of the angle taken (e.g. « bénéfice », « urgence »), for the operator. */
  angle: string | null;
};

export type PreheaderSuggestionsResponse = {
  suggestions: PreheaderSuggestion[];
  /** ISO 639-1 code detected by the model from the newsletter, when it said so. */
  language: string | null;
  model: string;
  /** Operator-facing remarks (fewer suggestions than asked, truncated content, images skipped, …). */
  notes: string[];
  /** Newsletter images the model actually looked at (vision input). */
  imagesAnalyzed: number;
};
