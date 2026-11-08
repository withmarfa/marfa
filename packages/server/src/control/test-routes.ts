import { Hono } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { z } from "zod";
import {
  advanceClock,
  clockOffsetMs,
  now,
  nowMs,
  pauseClock,
} from "../clock.js";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BlobLayer } from "../storage/blob-layer.js";
import { unfaulted } from "../storage/blob-faults.js";
import { bareHex } from "../storage/blob-store.js";
import { activeFaults, clearFaults, faultProblem, setFault } from "./faults.js";

const advanceInput = z.union([
  z.object({ advance_ms: z.number() }).strict(),
  z.object({ paused: z.boolean() }).strict(),
]);
const faultInput = z
  .object({ name: z.string(), arg: z.string().nullable().optional() })
  .strict();

function body(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => null);
}

/**
 * The clock and fault routes of the conformance harness. Mounted only on the
 * private control socket and only when `MARFA_TEST_HOOKS` is true; never on
 * the public listener. The target interface in `conformance/README.md` names
 * them as the adapter's means.
 */
export function testRoutes(
  jobNames: () => readonly string[],
  blobs: BlobLayer,
) {
  const app = new Hono();
  app.get("/clock", (c) =>
    c.json({ offset_ms: clockOffsetMs(), now: now().toISOString() }),
  );
  app.post("/clock", async (c) => {
    const input = advanceInput.safeParse(await body(c));
    if (!input.success)
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Provide advance_ms, a whole number of milliseconds, or paused, a boolean",
      );
    try {
      if ("paused" in input.data) pauseClock(input.data.paused);
      else advanceClock(input.data.advance_ms);
    } catch (error) {
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        (error as RangeError).message,
      );
    }
    return c.json({
      offset_ms: clockOffsetMs(),
      now: new Date(nowMs()).toISOString(),
    });
  });
  app.get("/blob-stores", async (c) => {
    const hash = c.req.query("hash");
    if (hash !== undefined && !/^sha256:[0-9a-f]{64}$/.test(hash))
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Provide hash as a sha256: blob name",
      );
    const stores = await Promise.all(
      blobs.stores.map(async (store) => {
        const real = unfaulted(store);
        const held = hash === undefined ? null : await real.has(hash);
        let intact = false;
        if (held !== null && hash !== undefined) {
          const read = await real.get(hash);
          if (read !== null) {
            const sum = createHash("sha256");
            for await (const chunk of read.stream) sum.update(chunk as Buffer);
            intact = sum.digest("hex") === bareHex(hash);
          }
        }
        return {
          id: store.id,
          kind: store.kind,
          holds: held !== null,
          intact,
        };
      }),
    );
    const names = await readdir(blobs.disk.spoolDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const spool = (
      await Promise.all(
        names.map(async (name) => {
          const size = await stat(join(blobs.disk.spoolDir, name)).then(
            (file) => file.size,
            (error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return null;
              throw error;
            },
          );
          return size === null ? null : { name, size };
        }),
      )
    ).filter((file) => file !== null);
    return c.json({ stores, spool });
  });
  app.get("/faults", (c) => c.json({ faults: activeFaults() }));
  app.put("/faults", async (c) => {
    const input = faultInput.safeParse(await body(c));
    if (!input.success)
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Provide the fault's name and, where it takes one, its arg",
      );
    const arg = input.data.arg ?? null;
    const problem = faultProblem(input.data.name, arg, jobNames());
    if (problem !== undefined)
      throw new MarfaError(ErrorCode.VALIDATION_ERROR, problem);
    setFault(input.data.name, arg);
    return c.json({ faults: activeFaults() });
  });
  app.delete("/faults", (c) => {
    clearFaults(c.req.query("name"));
    return c.json({ faults: activeFaults() });
  });
  return app;
}
