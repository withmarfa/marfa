import { Hono } from "hono";
import { MymeError, ErrorCode, isValidId } from "@myme/shared";
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
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid thread ID");
    }
    const tid = c.get("apiKey")?.tenant_id;
    const thread = await storage.threads.get(id, tid);
    if (!thread) {
      throw new MymeError(ErrorCode.THREAD_NOT_FOUND, `Thread ${id} not found`);
    }
    const items = await storage.threads.getItems(id, tid);
    return c.json({ thread, items });
  });

  // POST /threads/:id/items — add an item to a thread
  router.post("/:id/items", async (c) => {
    requireAuth(c);
    const threadId = c.req.param("id");
    if (!isValidId(threadId)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid thread ID");
    }

    const tid = c.get("apiKey")?.tenant_id;
    const thread = await storage.threads.get(threadId, tid);
    if (!thread) {
      throw new MymeError(
        ErrorCode.THREAD_NOT_FOUND,
        `Thread ${threadId} not found`,
      );
    }

    const body = await c.req.json();
    const itemId = body.item_id as string | undefined;
    if (!itemId || !isValidId(itemId)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "item_id is required and must be a valid ID",
      );
    }

    const item = await storage.items.get(itemId, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }

    const updated = await storage.items.update(
      itemId,
      { properties: item.properties, thread_id: threadId },
      tid,
    );
    if ("error" in updated) {
      throw new MymeError(ErrorCode.CONFLICT, "Version conflict");
    }

    await storage.threads.touch(threadId);
    return c.json({ item: updated });
  });

  // DELETE /threads/:id/items/:itemId — remove an item from a thread
  router.delete("/:id/items/:itemId", async (c) => {
    requireAuth(c);
    const threadId = c.req.param("id");
    const itemId = c.req.param("itemId");

    if (!isValidId(threadId)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid thread ID");
    }
    if (!isValidId(itemId)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid item ID");
    }

    const tid = c.get("apiKey")?.tenant_id;
    const item = await storage.items.get(itemId, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    if (item.thread_id !== threadId) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Item is not in this thread",
      );
    }

    const updated = await storage.items.update(
      itemId,
      { properties: item.properties, thread_id: null },
      tid,
    );
    if ("error" in updated) {
      throw new MymeError(ErrorCode.CONFLICT, "Version conflict");
    }

    await storage.threads.touch(threadId);
    return c.json({ item: updated });
  });

  return router;
}
