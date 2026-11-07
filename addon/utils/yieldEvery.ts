/**
 * For a long loop over synchronous database calls: each call to the returned function lets other requests run once
 * the loop has held the event loop for `sliceMs`, and costs nothing otherwise.
 */
export function yieldEvery(sliceMs = 15): () => Promise<void> {
  let since = Date.now();
  return async () => {
    if (Date.now() - since < sliceMs) return;
    await new Promise((resolve) => setImmediate(resolve));
    since = Date.now();
  };
}
