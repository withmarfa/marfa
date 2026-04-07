import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { parseIntParam } from "./util.js";

export function auditRoutes(storage: Storage): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // GET /audit — list audit log entries (admin only)
  router.get("/", async (c) => {
    requireAdmin(c);

    const result = await storage.audit.list({
      action: c.req.query("action") ?? undefined,
      resource_type: c.req.query("resource_type") ?? undefined,
      resource_id: c.req.query("resource_id") ?? undefined,
      since: c.req.query("since") ?? undefined,
      until: c.req.query("until") ?? undefined,
      limit: parseIntParam(c.req.query("limit"), 50, 1, 200),
      cursor: c.req.query("cursor") ?? undefined,
    });

    return c.json(result);
  });

  return router;
}
