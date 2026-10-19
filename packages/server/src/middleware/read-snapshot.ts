import type { RouteConfig } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./auth.js";
import type { Storage } from "../storage/interface.js";
import {
  queryKeyFamilies,
  takesQueryKeysLike,
} from "./undeclared-query-keys.js";

/** Keep row authorization, related rows, and registry reads in one state. */
export function snapshotReadRoute<R extends RouteConfig>(
  storage: Storage,
  route: R,
): R {
  const declared = route.middleware;
  return takesQueryKeysLike(
    {
      ...route,
      middleware: [
        createMiddleware<AppEnv>((c, next) =>
          storage.runInReadSnapshot(() => next(), { signal: c.req.raw.signal }),
        ),
        ...(declared === undefined
          ? []
          : Array.isArray(declared)
            ? declared
            : [declared]),
      ],
    },
    ...queryKeyFamilies(route),
  );
}
