/**
 * How a device code is written while a person types it: eight letters and
 * digits in capitals, in two groups of four with a dash between. Anything
 * else typed or pasted, spaces and dashes included, is dropped, and nothing
 * past the eighth character is kept. The server and the browser module share
 * it, so the page and its tests agree.
 */
export function formatDeviceCode(typed: string): string {
  const code = typed
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
