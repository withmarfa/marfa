import { Hono } from "hono";
import { ProtocolError, ErrorCode, isValidId } from "@myme/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { parseIntParam } from "./util.js";

export function threadRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post("/", (c) => {
    requireAuth(c);
    const thread = storage.threads.create();
    return c.json(thread, 201);
  });

  router.get("/", (c) => {
    requireAuth(c);
    const limit = parseIntParam(c.req.query("limit"), 50, 1, 100);
    const cursor = c.req.query("cursor");
    const result = storage.threads.list(limit, cursor ?? undefined);
    return c.json(result);
  });

  router.get("/:id", (c) => {
    requireAuth(c);
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid thread ID",
      );
    }
    const thread = storage.threads.get(id);
    if (!thread) {
      throw new ProtocolError(
        ErrorCode.NOT_FOUND,
        `Thread ${id} not found`,
      );
    }
    const items = storage.threads.getItems(id);
    return c.json({ thread, items });
  });

  return router;
}
