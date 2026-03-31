import { Hono } from "hono";
import {
  ProtocolError,
  ErrorCode,
  getTypeSchema,
  TYPE_REGISTRY,
} from "@myme/shared";
import type { AppEnv } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";

export function typeRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/", (c) => {
    requireAuth(c);
    return c.json(Array.from(TYPE_REGISTRY.values()));
  });

  router.get("/:id", (c) => {
    requireAuth(c);
    const id = c.req.param("id");
    const schema = getTypeSchema(id);
    if (!schema) {
      throw new ProtocolError(
        ErrorCode.TYPE_NOT_FOUND,
        `Type "${id}" not found`,
      );
    }
    return c.json(schema);
  });

  return router;
}
