import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { ProtocolError, ErrorCode, isValidId } from "@mymehq/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin, hashApiKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

const KEY_PREFIX = "myme_k1_";

function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

export function keyRoutes(storage: Storage, salt: string): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post("/", async (c) => {
    const isBootstrap = c.get("isBootstrap");
    if (!isBootstrap) {
      requireAdmin(c);
    }

    const body = await c.req.json();

    if (!body.label || typeof body.label !== "string" || !body.label.trim()) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "label is required");
    }

    const role = isBootstrap
      ? "admin"
      : ((body.role as string | undefined) ?? "member");
    if (role !== "admin" && role !== "member") {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "role must be 'admin' or 'member'",
      );
    }

    const typePermissions =
      (body.type_permissions as Record<string, string> | undefined) ?? {};

    // Validate permission values
    const validPermissions = new Set(["read", "write", "none"]);
    for (const [pattern, perm] of Object.entries(typePermissions)) {
      if (!validPermissions.has(perm)) {
        throw new ProtocolError(
          ErrorCode.VALIDATION_ERROR,
          `Invalid permission value "${perm}" for type pattern "${pattern}". Must be "read", "write", or "none"`,
        );
      }
    }

    const rawKey = generateRawKey();
    const keyHash = hashApiKey(rawKey, salt);

    const stored = await storage.keys.create(
      {
        label: body.label.trim(),
        role: role,
        type_permissions: typePermissions as Record<
          string,
          "read" | "write" | "none"
        >,
      },
      keyHash,
    );

    return c.json(
      {
        id: stored.id,
        key: rawKey,
        label: stored.label,
        role: stored.role,
        type_permissions: stored.type_permissions,
        created_at: stored.created_at,
        last_used_at: stored.last_used_at,
      },
      201,
    );
  });

  router.get("/", async (c) => {
    requireAdmin(c);
    return c.json({ keys: await storage.keys.list() });
  });

  router.delete("/:id", async (c) => {
    requireAdmin(c);
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(ErrorCode.VALIDATION_ERROR, "Invalid key ID");
    }
    await storage.keys.revoke(id);
    return c.json({ ok: true });
  });

  return router;
}
