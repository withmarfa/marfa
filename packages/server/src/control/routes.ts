import { Hono } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { z } from "zod";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";
import {
  claimOwner,
  getClaimStatus,
  issueSetupCode,
  issueSetupTicket,
  recoverOwnerPassword,
} from "../auth/instance-claim.js";
import { ownerWire } from "../routes/owner-wire.js";

const ownerInput = z
  .object({
    email: z.string(),
    password: z.string(),
    name: z.string().optional(),
  })
  .strict();
const recoveryInput = z.object({ password: z.string() }).strict();

/** Mounted only on the private listener, never the public router. */
export function controlRoutes(
  storage: Storage,
  auth: MarfaAuth,
  baseURL: string,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/setup/status", async (c) => {
    const { claimed, ownerId, generation } = await getClaimStatus(storage);
    return c.json({ claimed, owner_id: ownerId, generation });
  });
  app.post("/setup/code", async (c) => c.json(await issueSetupCode(storage)));
  app.post("/setup/ticket", async (c) => {
    const result = await issueSetupTicket(storage);
    const url = new URL("/setup", baseURL);
    url.hash = `handoff=${result.ticket}`;
    return c.json({
      ticket: result.ticket,
      expires_at: new Date(result.expiresAt).toISOString(),
      url: url.toString(),
    });
  });
  app.post("/setup/claim", async (c) => {
    const input = ownerInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Provide an email and password, and optionally a name",
      );
    const owner = await claimOwner(storage, auth, {
      ...input.data,
      proof: { kind: "local" },
    });
    return c.json(ownerWire(owner), 201);
  });
  app.post("/owner/recover", async (c) => {
    const input = recoveryInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Provide the new password",
      );
    await recoverOwnerPassword(storage, auth, input.data);
    return c.json({ recovered: true });
  });
  return app;
}
