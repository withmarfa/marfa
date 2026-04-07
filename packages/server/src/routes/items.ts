import { Hono } from "hono";
import {
  MymeError,
  ErrorCode,
  isValidId,
  isValidTimestamp,
  isValidTypeIdentifier,
  getTypeSchema,
  validateProperties,
  ITEM_STATES,
} from "@mymehq/shared";
import type { ItemState } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import {
  requireAuth,
  requireAdmin,
  requireTypeAccess,
  getTypeFilter,
} from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { publish } from "../graphql/pubsub.js";
import { parseIntParam } from "./util.js";

export function itemRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // POST /items — create
  router.post("/", async (c) => {
    const body = await c.req.json();

    const type = body.type as string | undefined;
    if (!type) {
      throw new MymeError(
        ErrorCode.MISSING_REQUIRED_FIELD,
        "type is required",
        {
          field: "type",
        },
      );
    }
    if (!isValidTypeIdentifier(type)) {
      throw new MymeError(
        ErrorCode.INVALID_TYPE,
        `Invalid type identifier: ${type}`,
      );
    }

    const properties =
      (body.properties as Record<string, unknown> | undefined) ?? {};
    if (typeof properties !== "object") {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "properties must be an object",
      );
    }

    if (body.id && !isValidId(body.id as string)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }
    if (body.timestamp && !isValidTimestamp(body.timestamp as string)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid timestamp");
    }
    if (body.parent_id && !isValidId(body.parent_id as string)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid parent_id");
    }
    if (body.thread_id && !isValidId(body.thread_id as string)) {
      throw new MymeError(ErrorCode.VALIDATION_ERROR, "Invalid thread_id");
    }
    if (body.state) {
      const typeSchema = getTypeSchema(type);
      const validStates = typeSchema
        ? (typeSchema.states as string[])
        : (ITEM_STATES as readonly string[]);
      if (!validStates.includes(body.state as string)) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          `Invalid state: ${body.state as string}`,
        );
      }
    }

    requireTypeAccess(c, type, "write");
    const tenantId = c.get("apiKey")?.tenant_id;

    if (Array.isArray(body.tags) && body.tags.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item",
      );
    }
    if (Array.isArray(body.about) && body.about.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 about references per item",
      );
    }

    const item = await storage.items.create(
      {
        type,
        properties,
        id: body.id as string | undefined,
        state: body.state as ItemState | undefined,
        timestamp: body.timestamp as string | undefined,
        source: body.source as string | undefined,
        source_id: body.source_id as string | undefined,
        origin: body.origin as string | undefined,
        device_id: body.device_id as string | undefined,
        parent_id: body.parent_id as string | undefined,
        thread_id: body.thread_id as string | undefined,
        capture_latitude: body.capture_latitude as number | undefined,
        capture_longitude: body.capture_longitude as number | undefined,
        tags: body.tags as string[] | undefined,
        about: body.about as string[] | undefined,
      },
      tenantId,
    );

    const metadata = await storage.metadata.get(item.id);
    publish({ type: "created", item, metadata, tenantId });
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.create",
      resource_type: "item",
      resource_id: item.id,
      details: { type: item.type },
    });
    return c.json({ item, metadata }, 201);
  });

  // GET /items/stats — item counts grouped by state
  router.get("/stats", async (c) => {
    requireAuth(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    const allowedTypes = getTypeFilter(c);
    const stats = await storage.items.stats(tenantId, allowedTypes);
    return c.json(stats);
  });

  // GET /items — list
  router.get("/", async (c) => {
    requireAuth(c);

    const type = c.req.query("type");
    if (type && !isValidTypeIdentifier(type) && !type.endsWith(".*")) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid type identifier",
      );
    }
    // Type access for list is enforced by allowed_types filtering, not 403 rejection.
    // This lets scoped keys list any type and get filtered (empty) results.

    const state = c.req.query("state") as ItemState | undefined;
    if (state && !(ITEM_STATES as readonly string[]).includes(state)) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid state: ${state}`,
      );
    }

    // Fix 6: tags query param
    const tagsParam = c.req.query("tags");
    const tags = tagsParam
      ? tagsParam.split(",").map((t) => t.trim())
      : undefined;

    const filter = c.req.query("filter") ?? undefined;

    const rootOnly = c.req.query("root_only") === "true";
    const includeMetadata = c.req.query("include") === "metadata";

    const result = await storage.items.list({
      tenantId: c.get("apiKey")?.tenant_id,
      type,
      state,
      source: c.req.query("source"),
      parent_id: c.req.query("parent_id"),
      thread_id: c.req.query("thread_id"),
      root_only: rootOnly || undefined,
      tags,
      filter,
      allowed_types: getTypeFilter(c),
      sort:
        (c.req.query("sort") as
          | "created_at"
          | "updated_at"
          | "timestamp"
          | undefined) ?? undefined,
      direction:
        (c.req.query("direction") as "asc" | "desc" | undefined) ?? undefined,
      since: c.req.query("since"),
      until: c.req.query("until"),
      limit: parseIntParam(c.req.query("limit"), 50, 1, 200),
      cursor: c.req.query("cursor"),
    });

    if (includeMetadata) {
      const ids = result.data.map((item) => item.id);
      const metadataList = await storage.metadata.getMany(ids);
      const metadataMap = new Map(metadataList.map((m) => [m.item_id, m]));
      return c.json({
        data: result.data.map((item) => ({
          item,
          metadata: metadataMap.get(item.id) ?? {
            item_id: item.id,
            tags: [],
            about: [],
            extensions: {},
          },
        })),
        cursor: result.cursor,
        has_more: result.has_more,
      });
    }

    return c.json(result);
  });

  // GET /items/:id — get single
  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const tid = c.get("apiKey")?.tenant_id;
    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
    const metadata = await storage.metadata.get(id);
    return c.json({ item, metadata });
  });

  // PATCH /items/:id — update with conflict detection
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const body = await c.req.json();
    const hasProperties =
      body.properties !== undefined && typeof body.properties === "object";
    const hasParentId = "parent_id" in body;
    const hasThreadId = "thread_id" in body;

    if (!hasProperties && !hasParentId && !hasThreadId) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "At least one of properties, parent_id, or thread_id is required",
      );
    }
    if (body.version !== undefined) {
      if (
        typeof body.version !== "number" ||
        !Number.isInteger(body.version) ||
        body.version < 0
      ) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          "version must be a non-negative integer",
        );
      }
    }

    // Validate parent_id if provided
    if (hasParentId && body.parent_id !== null) {
      if (typeof body.parent_id !== "string" || !isValidId(body.parent_id)) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          "parent_id must be a valid ID or null",
        );
      }
      if (body.parent_id === id) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          "An item cannot be its own parent",
        );
      }
    }

    // Validate thread_id if provided
    if (hasThreadId && body.thread_id !== null) {
      if (typeof body.thread_id !== "string" || !isValidId(body.thread_id)) {
        throw new MymeError(
          ErrorCode.VALIDATION_ERROR,
          "thread_id must be a valid ID or null",
        );
      }
    }

    const tid = c.get("apiKey")?.tenant_id;

    // Verify thread exists if setting a non-null thread_id
    if (hasThreadId && body.thread_id !== null) {
      const thread = await storage.threads.get(body.thread_id as string, tid);
      if (!thread) {
        throw new MymeError(
          ErrorCode.THREAD_NOT_FOUND,
          `Thread ${body.thread_id as string} not found`,
        );
      }
    }

    const item = await storage.items.get(id, tid);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    // Cycle detection: walk up from proposed parent to ensure this item isn't an ancestor
    if (hasParentId && body.parent_id !== null) {
      let current = body.parent_id as string;
      const visited = new Set<string>([id]);
      while (current) {
        if (visited.has(current)) {
          throw new MymeError(
            ErrorCode.VALIDATION_ERROR,
            "Setting this parent_id would create a cycle",
          );
        }
        visited.add(current);
        const ancestor = await storage.items.get(current, tid);
        if (!ancestor?.parent_id) break;
        current = ancestor.parent_id;
      }
    }

    if (hasProperties) {
      const merged = {
        ...item.properties,
        ...(body.properties as Record<string, unknown>),
      };
      if (getTypeSchema(item.type)) {
        const validation = validateProperties(item.type, merged);
        if (!validation.success) {
          throw new MymeError(
            ErrorCode.INVALID_PROPERTIES,
            "Invalid properties",
            {
              errors: validation.errors,
            },
          );
        }
      }
    }

    const result = await storage.items.update(
      id,
      {
        properties: hasProperties
          ? (body.properties as Record<string, unknown>)
          : undefined,
        parent_id: hasParentId ? (body.parent_id as string | null) : undefined,
        thread_id: hasThreadId ? (body.thread_id as string | null) : undefined,
        version: body.version as number,
        snapshot: body.snapshot === true ? true : undefined,
      },
      tid,
    );

    // Touch thread updated_at when thread assignment changes
    if (hasThreadId && body.thread_id !== null) {
      await storage.threads.touch(body.thread_id as string);
    }

    // Fix 1: wrap in { item, metadata }
    if ("error" in result) {
      return c.json(result, 409);
    }

    const metadata = await storage.metadata.get(id);
    publish({ type: "updated", item: result, metadata, tenantId: tid });
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.update",
      resource_type: "item",
      resource_id: id,
    });
    return c.json({ item: result, metadata });
  });

  // DELETE /items/:id — soft delete
  // Fix 1: return 200 { ok: true } instead of 204
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireAuth(c);
    const tid = c.get("apiKey")?.tenant_id;
    const existing = await storage.items.get(id, tid);
    await storage.items.delete(id, tid);
    if (existing) {
      publish({
        type: "deleted",
        item: { ...existing, state: "trashed" as ItemState },
        tenantId: tid,
      });
    }
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.delete",
      resource_type: "item",
      resource_id: id,
    });
    return c.json({ ok: true });
  });

  // POST /items/:id/restore — Fix 1: wrap in { item, metadata }
  router.post("/:id/restore", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireAuth(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    const restored = await storage.items.restore(id, tenantId);
    requireTypeAccess(c, restored.type, "write");
    const metadata = await storage.metadata.get(id);
    publish({ type: "restored", item: restored, metadata, tenantId });
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.restore",
      resource_type: "item",
      resource_id: id,
    });
    return c.json({ item: restored, metadata });
  });

  // POST /items/:id/transition — Fix 1: wrap in { item, metadata }
  router.post("/:id/transition", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const body = await c.req.json();
    const state = body.state as string | undefined;
    if (!state || typeof state !== "string") {
      throw new MymeError(
        ErrorCode.INVALID_TRANSITION,
        `Invalid state: ${String(state)}`,
      );
    }

    requireAuth(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    const item = await storage.items.get(id, tenantId);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, "Item not found");
    }
    requireTypeAccess(c, item.type, "write");
    const updated = await storage.items.transition(
      id,
      state as ItemState,
      tenantId,
    );
    const metadata = await storage.metadata.get(id);
    publish({ type: "transitioned", item: updated, metadata, tenantId });
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.transition",
      resource_type: "item",
      resource_id: id,
      details: { from_state: item.state, to_state: state },
    });
    return c.json({ item: updated, metadata });
  });

  // GET /items/:id/versions — Fix 1: wrap in { versions: [...] }
  router.get("/:id/versions", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
    const versions = await storage.versions.list(id);
    return c.json({ versions });
  });

  // --- Metadata sub-routes ---

  // GET /items/:id/metadata — Fix 1: wrap in { metadata: {...} }
  router.get("/:id/metadata", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "read");
    return c.json({ metadata: await storage.metadata.get(id) });
  });

  // PUT /items/:id/metadata — full replacement. Fix 1: wrap in { metadata: {...} }
  router.put("/:id/metadata", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    const body = await c.req.json();
    const tags = (body.tags as string[] | undefined) ?? [];
    const about = (body.about as string[] | undefined) ?? [];

    if (tags.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item",
      );
    }
    if (about.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 about references per item",
      );
    }

    const metadata = await storage.metadata.set(id, tags, about);
    return c.json({ metadata });
  });

  // PATCH /items/:id/metadata — Fix 2: set-union merge
  router.patch("/:id/metadata", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    const body = await c.req.json();
    const tags = body.tags as string[] | undefined;
    const about = body.about as string[] | undefined;

    // Pre-merge bounds check on incoming arrays
    if (Array.isArray(tags) && tags.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item",
      );
    }
    if (Array.isArray(about) && about.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 about references per item",
      );
    }

    const metadata = await storage.metadata.merge(id, tags, about);

    // Post-merge bounds check (incoming may be small but merge could exceed)
    if (metadata.tags.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item (including existing tags)",
      );
    }
    if (metadata.about.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 about references per item (including existing)",
      );
    }

    return c.json({ metadata });
  });

  // POST /items/:id/tags
  router.post("/:id/tags", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");

    const body = await c.req.json();
    const tags = body.tags as string[] | undefined;
    if (!Array.isArray(tags) || tags.length === 0) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "tags must be a non-empty array of strings",
      );
    }

    const metadata = await storage.metadata.addTags(id, tags);
    if (metadata.tags.length > 100) {
      throw new MymeError(
        ErrorCode.VALIDATION_ERROR,
        "Maximum 100 tags per item (including existing tags)",
      );
    }
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.tag",
      resource_type: "item",
      resource_id: id,
      details: { tags },
    });
    return c.json({ metadata });
  });

  // DELETE /items/:id/purge — permanently delete a trashed item (admin only)
  router.delete("/:id/purge", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    requireAdmin(c);
    const tenantId = c.get("apiKey")?.tenant_id;
    await storage.items.purge(id, tenantId);
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.purge",
      resource_type: "item",
      resource_id: id,
    });
    return c.json({ ok: true });
  });

  // DELETE /items/:id/tags/:tag
  router.delete("/:id/tags/:tag", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new MymeError(ErrorCode.INVALID_ID, "Invalid item ID");
    }

    const item = await storage.items.get(id, c.get("apiKey")?.tenant_id);
    if (!item) {
      throw new MymeError(ErrorCode.ITEM_NOT_FOUND, `Item ${id} not found`);
    }

    requireTypeAccess(c, item.type, "write");
    const tag = decodeURIComponent(c.req.param("tag"));
    const metadata = await storage.metadata.removeTag(id, tag);
    void storage.audit.log({
      key_id: c.get("apiKey")?.id,
      action: "item.untag",
      resource_type: "item",
      resource_id: id,
      details: { tag },
    });
    return c.json({ metadata });
  });

  return router;
}
