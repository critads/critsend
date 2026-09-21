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