/**
 * The SSE read helper the streaming suites drive their assertions through.
 *
 * It is worth its own tests because two suites hand-rolled it, both copies
 * carried the same defect, and the defect was invisible on an idle machine:
 * a read that lost chunks under load reported a timeout naming neither the
 * condition it was waiting for nor what it had actually read, so it looked
 * like an SSE regression every time.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readSse, SSE_READ_CEILING_MS } from "./test-utils.js";

const encoder = new TextEncoder();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A response whose body emits `chunks`, pausing `gapMs` before each. */
function pacedResponse(
  chunks: string[],
  gapMs: number,
  close = true,
): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        await sleep(gapMs);
        controller.enqueue(encoder.encode(chunk));
      }
      if (close) controller.close();
    },
  });
  return new Response(body);
}

describe("readSse", () => {
  it("loses no chunk when the stream delivers slower than the loop polls", async () => {
    // The property the two hand-rolled copies broke. Each iteration issued a
    // fresh `read()` and abandoned it when its 50ms tick won the race; reads
    // are fulfilled in arrival order, so the next chunk went to an abandoned
    // read whose resolve landed on an already-settled promise. On an idle
    // machine the first read always won and nothing was ever abandoned.
    const { text, closed } = await readSse(
      pacedResponse(["alpha\n", "beta\n", "gamma\n", "delta\n"], 120),
      { untilClosed: true, timeoutMs: 5_000 },
    );

    expect(text).toBe("alpha\nbeta\ngamma\ndelta\n");
    expect(closed).toBe(true);
  });

  it("returns as soon as its condition holds, without spending the budget", async () => {
    const started = Date.now();
    const { text } = await readSse(
      pacedResponse(["one\n", "two\n", "three\n"], 30, false),
      { until: (t) => t.includes("two") },
    );

    expect(text).toContain("two");
    expect(Date.now() - started).toBeLessThan(SSE_READ_CEILING_MS / 2);
  });

  it("throws with what it read when the condition never holds", async () => {
    await expect(
      readSse(pacedResponse(["only\n"], 10, false), {
        until: (t) => t.includes("never-arrives"),
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/did not reach its condition.*"only\\n"/s);
  });

  it("throws rather than reporting a stream stayed open when it closed", async () => {
    await expect(
      readSse(pacedResponse(["hello\n"], 10, false), {
        untilClosed: true,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/stayed open for 200ms/);
  });

  it("refuses to let an absence assertion run on a stream that delivered nothing", async () => {
    // The trap this exists for: "no catchup_too_old arrived" is trivially
    // true of a read that never happened.
    await expect(
      readSse(pacedResponse([], 10, false), {
        requireSeen: (t) => t.startsWith(": connected"),
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/cannot prove it was reading a live stream/);
  });

  it("keeps a multi-byte character split across two chunks intact", async () => {
    const bytes = encoder.encode("héllo");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split inside the two-byte é.
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    });

    const { text } = await readSse(new Response(body), { untilClosed: true });
    expect(text).toBe("héllo");
  });

  it("keeps its ceiling below the suite timeout so its diagnostic can print", () => {
    // The two used to be equal at 60s, so vitest's timer always won and the
    // message naming the condition and the partial read could never appear.
    // Read as text rather than imported: pulling the vitest config into the
    // module graph drags it into the lint project service too.
    const config = readFileSync(
      fileURLToPath(new URL("../vitest.config.ts", import.meta.url)),
      "utf8",
    );
    const declared = /testTimeout:\s*([\d_]+)/.exec(config)?.[1];
    expect(declared).toBeDefined();
    expect(SSE_READ_CEILING_MS).toBeLessThan(
      Number(declared!.replace(/_/g, "")),
    );
  });
});
