import {
  SMART_SEGMENT_MAX_SIMILAR_REFS,
  normalizeSimilarRefs,
  smartSegmentRefSchema,
  type SmartSegmentSimilarBrand,
} from "@shared/smart-segment";

export type ParsedSmartSegmentError = {
  status: number | null;
  message: string;
  code: string | null;
};

export function formatSmartSegmentPercent(value: number, digits = 2): string {
  return new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value * 100);
}

export function clampComplaintCapPercent(value: number): number {
  if (!Number.isFinite(value)) return 0.45;
  return Math.max(0.05, Math.min(0.6, value));
}

export function complaintRateColor(value: number): string {
  if (value >= 0.006) return "text-red-600";
  if (value >= 0.0045) return "text-amber-600";
  return "text-green-600";
}

export function defaultSimilarBrandRefs(candidates: readonly SmartSegmentSimilarBrand[]): string[] {
  return normalizeSimilarRefs(candidates.map((candidate) => candidate.ref)).slice(0, SMART_SEGMENT_MAX_SIMILAR_REFS);
}

export function validateManualSimilarRef(
  value: string,
  forbiddenRefs: readonly string[],
  selectedRefs: readonly string[],
): { ref: string | null; error: string | null } {
  const ref = value.trim().toUpperCase();
  const parsed = smartSegmentRefSchema.safeParse(ref);
  if (!parsed.success) return { ref: null, error: parsed.error.issues[0]?.message ?? "Ref invalide" };
  const forbidden = new Set(normalizeSimilarRefs([...forbiddenRefs, "DEL"]));
  if (forbidden.has(ref)) return { ref: null, error: "Cette ref ne peut pas être ajoutée." };
  if (normalizeSimilarRefs(selectedRefs).includes(ref)) return { ref: null, error: "Cette ref est déjà sélectionnée." };
  if (normalizeSimilarRefs(selectedRefs).length >= SMART_SEGMENT_MAX_SIMILAR_REFS) {
    return { ref: null, error: `${SMART_SEGMENT_MAX_SIMILAR_REFS} refs maximum` };
  }
  return { ref, error: null };
}

export function parseSmartSegmentApiError(error: unknown): ParsedSmartSegmentError {
  const apiError = error as { status?: unknown; body?: unknown; message?: unknown };
  let status = typeof apiError?.status === "number" ? apiError.status : null;
  let message = typeof apiError?.message === "string" ? apiError.message : "Une erreur inattendue est survenue.";
  let code: string | null = null;
  if (apiError?.body && typeof apiError.body === "object") {
    const body = apiError.body as { error?: unknown; code?: unknown };
    if (typeof body.error === "string") message = body.error;
    if (typeof body.code === "string") code = body.code;
    return { status, message, code };
  }
  const match = message.match(/^(\d{3}):\s*([\s\S]*)$/);
  if (match) {
    status = Number(match[1]);
    try {
      const body = JSON.parse(match[2]) as { error?: unknown; code?: unknown };
      if (typeof body.error === "string") message = body.error;
      if (typeof body.code === "string") code = body.code;
    } catch {
      message = match[2] || message;
    }
  }
  return { status, message, code };
}