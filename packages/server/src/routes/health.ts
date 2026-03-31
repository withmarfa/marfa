import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth.js";

export function healthRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/", (c) =>
    c.json({
      name: "myme",
      version: "0.0.1",
      features: [
        "items",
        "threads",
        "search",
        "blobs",
        "types",
        "keys",
        "import",
        "export",
      ],
    }),
  );

  router.get("/health", (c) => c.json({ status: "ok" }));

  return router;
}
