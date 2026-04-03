import { Hono } from "hono";
import { ProtocolError, ErrorCode, isValidId } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { parseIntParam } from "./util.js";

export function threadRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post("/", async (c) => {
    requireAuth(c);
    const thread = await storage.threads.create(c.get("apiKey")?.tenant_id);
    return c.json({ thread }, 201);
  });

  router.get("/", async (c) => {
    requireAuth(c);
    const limit = parseIntParam(c.req.query("limit"), 50, 1, 100);
    const cursor = c.req.query("cursor");
    const tid = c.get("apiKey")?.tenant_id;
    const result = await storage.threads.list(limit, cursor ?? undefined, tid);
    return c.json(result);
  });

  router.get("/:id", async (c) => {
    requireAuth(c);
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid thread ID");
    }
    const tid = c.get("apiKey")?.tenant_id;
    const thread = await storage.threads.get(id, tid);
    if (!thread) {
      throw new ProtocolError(
        ErrorCode.THREAD_NOT_FOUND,
        `Thread ${id} not found`,
      );
    }
    const items = await storage.threads.getItems(id, tid);
    return c.json({ thread, items });
  });

  return router;
}
