import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import {
  ProtocolError,
  ErrorCode,
  isValidId,
} from "@myme/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin, hashApiKey } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

const KEY_PREFIX = "myme_k1_";

function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

export function keyRoutes(
  storage: Storage,
  salt: string,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post("/", async (c) => {
    const isBootstrap = c.get("isBootstrap");
    if (!isBootstrap) {
      requireAdmin(c);
    }

    const body = (await c.req.json()) as Record<string, unknown>;

    if (
      !body["label"] ||
      typeof body["label"] !== "string" ||
      !(body["label"] as string).trim()
    ) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "label is required",
      );
    }

    const role = isBootstrap
      ? "admin"
      : ((body["role"] as string | undefined) ?? "member");
    if (role !== "admin" && role !== "member") {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "role must be 'admin' or 'member'",
      );
    }

    const typePermissions =
      (body["type_permissions"] as Record<string, string> | undefined) ?? {};

    const rawKey = generateRawKey();
    const keyHash = hashApiKey(rawKey, salt);

    const stored = storage.keys.create(
      {
        label: (body["label"] as string).trim(),
        role: role as "admin" | "member",
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
      },
      201,
    );
  });

  router.get("/", (c) => {
    requireAdmin(c);
    return c.json(storage.keys.list());
  });

  router.delete("/:id", (c) => {
    requireAdmin(c);
    const id = c.req.param("id");
    if (!isValidId(id)) {
      throw new ProtocolError(
        ErrorCode.VALIDATION_ERROR,
        "Invalid key ID",
      );
    }
    storage.keys.revoke(id);
    return c.body(null, 204);
  });

  return router;
}
