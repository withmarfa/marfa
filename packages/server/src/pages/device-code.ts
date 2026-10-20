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

/** How many letters and digits of `typed` come before `position`. */
export function charactersBefore(typed: string, position: number): number {
  return typed.slice(0, position).replace(/[^A-Za-z0-9]/g, "").length;
}

/** Where the cursor sits in a formatted code after `count` letters and digits. */
export function positionAfter(formatted: string, count: number): number {
  return Math.min(count > 4 ? count + 1 : count, formatted.length);
}
