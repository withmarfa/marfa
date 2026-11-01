import { vi } from "vitest";

/**
 * Collect the JSON lines the server logs to standard output from now on, until
 * the caller restores its mocks. A chunk may hold several lines or text that
 * is not a log line (the test runner's own output), which is skipped.
 */
export function captureLogLines(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    for (const line of String(chunk).split("\n")) {
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Not a JSON log line.
      }
    }
    return true;
  });
  return lines;
}
