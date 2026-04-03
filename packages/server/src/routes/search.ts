import { Hono } from "hono";
import {
  ProtocolError,
  ErrorCode,
  ITEM_STATES,
  isValidTypeIdentifier,
} from "@myme/shared";
import type { ItemState } from "@myme/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireTypeAccess,
  getTypeFilter,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { parseIntParam } from "./util.js";

export function searchRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/", async (c) => {
    requireAuth(c);

    const q = c.req.query("q");
    if (!q?.trim()) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "Query parameter 'q' is required",
      );
    }

    const type = c.req.query("type");
    if (type && !isValidTypeIdentifier(type)) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }

    const state = c.req.query("state") as ItemState | undefined;
    if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid state: ${state}`,
      );
    }

    if (type) requireTypeAccess(c, type, "read");

    const limit = parseIntParam(c.req.query("limit"), 20, 1, 100);
    const offset = parseIntParam(c.req.query("offset"), 0, 0, 10000);
    const filter = c.req.query("filter") ?? undefined;
    const allowed_types = getTypeFilter(c);

    const results = await storage.search.search(q.trim(), {
      tenantId: c.get("apiKey")?.tenant_id,
      type,
      state,
      filter,
      allowed_types,
      limit,
      offset: offset > 0 ? offset : undefined,
    });

    return c.json({ results });
  });

  return router;
}
