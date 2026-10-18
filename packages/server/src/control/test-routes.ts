import { Hono } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { z } from "zod";
import { advanceClock, clockOffsetMs, now, nowMs } from "../clock.js";
import { activeFaults, clearFaults, faultProblem, setFault } from "./faults.js";

const advanceInput = z.object({ advance_ms: z.number() }).strict();
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
export function testRoutes() {
  const app = new Hono();
  app.get("/clock", (c) =>
    c.json({ offset_ms: clockOffsetMs(), now: now().toISOString() }),
  );
  app.post("/clock", async (c) => {
    const input = advanceInput.safeParse(await body(c));
    if (!input.success)
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Provide advance_ms, a whole number of milliseconds",
      );
    try {
      advanceClock(input.data.advance_ms);
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
  app.get("/faults", (c) => c.json({ faults: activeFaults() }));
  app.put("/faults", async (c) => {
    const input = faultInput.safeParse(await body(c));
    if (!input.success)
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Provide the fault's name and, where it takes one, its arg",
      );
    const arg = input.data.arg ?? null;
    const problem = faultProblem(input.data.name, arg);
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
