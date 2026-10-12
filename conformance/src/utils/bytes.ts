/**
 * Where `actual` first differs from `expected`, or `null` when they hold the
 * same bytes, for a body too large for `toEqual`. Vitest compares a typed
 * array as an object with a key per byte: two equal 8 MiB buffers take more
 * than the 2 GB of heap Node gets on a macOS runner.
 */
export function byteDifference(
  actual: Uint8Array,
  expected: Uint8Array,
): string | null {
  if (Buffer.compare(actual, expected) === 0) return null;
  const shared = Math.min(actual.length, expected.length);
  let offset = 0;
  while (offset < shared && actual[offset] === expected[offset]) offset++;
  return `${String(actual.length)} bytes where ${String(expected.length)} were expected, the first difference at offset ${String(offset)}`;
}
