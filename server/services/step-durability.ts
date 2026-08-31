export async function runAfterDurableFinalization(
  outstandingFlush: Promise<void> | null,
  checkpoint: () => Promise<void>,
): Promise<void> {
  if (outstandingFlush) {
    await outstandingFlush;
  }
  await checkpoint();
}