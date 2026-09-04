export function shouldRetrySegmentSuggestions(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (!(error instanceof Error)) return true;
  const statusMatch = error.message.match(/^(\d{3}):/);
  if (!statusMatch) return true;
  const status = Number(statusMatch[1]);
  return status === 429 || status >= 500;
}