import { Hono } from "hono";
import { isValidId } from "@withmarfa/shared";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { log } from "../middleware/logger.js";
import { errorMessage } from "../error-text.js";
import { listFolders, folderSummary } from "../folder-inventory.js";
import { readFolderStatus } from "../folder-status-read.js";
import { readInstanceName } from "../instance-name.js";
import { parsePageSize } from "../pages/navigation.js";
import type { Storage } from "../storage/interface.js";
import * as clock from "../clock.js";
import { CONSOLE_PAGES } from "./console.js";
import {
  FOLDERS_HREF,
  folderHref,
  renderFolderDetail,
  renderFolderList,
  renderMissingFolder,
} from "./folder-pages.js";

async function readReports(storage: Storage, id: string) {
  try {
    return await readFolderStatus(storage, id);
  } catch (error) {
    log("warn", "console: folder reports unavailable", {
      folder: id,
      error: errorMessage(error),
    });
    return null;
  }
}
CONSOLE_PAGES.register("folders", {
  href: FOLDERS_HREF,
  hasItems: true,
  value: async ({ storage }) => {
    const counts = await storage.items.stats({
      types: ["system.folder"],
      states: ["active"],
    });
    const count = counts.active ?? 0;
    return {
      text:
        count === 0
          ? "None"
          : `${String(count)} ${count === 1 ? "folder" : "folders"}`,
    };
  },
});

export function folderPageRoutes(storage: Storage) {
  const router = new Hono<AppEnv>();
  router.get("/folders", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, ["cursor", "size"]);
    const size = parsePageSize(c.req.query("size"));
    const result = await storage.runInTransaction(async () => {
      requireDirectAuthority(c);
      const page = await listFolders(storage, size, c.req.query("cursor"));
      const rows = [];
      for (const folder of page.data)
        rows.push({ folder, status: await readReports(storage, folder.id) });
      return { rows, next: page.next_cursor };
    });
    return c.html(
      renderFolderList({
        ...result,
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        now: clock.nowMs(),
        continued: !!c.req.query("cursor"),
        size,
      }),
    );
  });
  router.get("/folders/:id", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, []);
    const id = c.req.param("id");
    const result = await storage.runInTransaction(async () => {
      requireDirectAuthority(c);
      const item = isValidId(id) ? await storage.items.get(id) : null;
      if (item?.type !== "system.folder" || item.state !== "active")
        return null;
      return {
        siblings: (await listFolders(storage, 100)).data.map((folder) => ({
          title: folder.title,
          href: folderHref(folder.id),
        })),
        folder: folderSummary(item),
        status: await readReports(storage, id),
      };
    });
    const base = {
      nonce: c.var.cspNonce,
      instanceName: await readInstanceName(storage.settings),
      now: clock.nowMs(),
    };
    return result
      ? c.html(renderFolderDetail({ ...base, ...result }))
      : c.html(renderMissingFolder(base), 404);
  });
  return router;
}
