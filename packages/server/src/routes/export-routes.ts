/**
 * The Export and restore page's route, read from storage and drawn by
 * `export-page.tsx`. It is the owner's: a browser without the owner's session
 * is sent to sign in by the console's gate, and a caller that is not the owner
 * is refused here.
 */
import { Hono } from "hono";
import { readInstanceName } from "../instance-name.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import type { SelectGroup, SelectOption } from "../pages/parts/index.js";
import type { Storage } from "../storage/interface.js";
import { resolveChoosableTypes } from "./access-types.js";
import { CONSOLE_PAGES } from "./console.js";
import { signInLeft } from "./confirm-gate.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import { renderExportPage } from "./export-page.js";

export const EXPORT_HREF = "/auth/owner/export";

CONSOLE_PAGES.register("export", { href: EXPORT_HREF });

const UNITS = ["bytes", "KB", "MB", "GB", "TB"] as const;

/** "0 bytes", "850 KB", "1.4 GB": decimal units, one decimal below ten. */
export function sizeWords(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const text =
    unit === 0 || value >= 10
      ? String(Math.round(value))
      : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${UNITS[unit] ?? "bytes"}`;
}

const BUILT_IN = "core.";

/** The types the export can be narrowed to: the platform's, then the ones apps and the owner added. */
async function typeOptions(
  storage: Storage,
): Promise<(SelectOption | SelectGroup)[]> {
  const types = await resolveChoosableTypes(storage, []);
  const option = (type: { id: string; label?: string }): SelectOption => ({
    value: type.id,
    label: type.label ?? type.id,
  });
  const builtIn = types.filter((type) => type.id.startsWith(BUILT_IN));
  const added = types.filter((type) => !type.id.startsWith(BUILT_IN));
  return [
    { value: "", label: "Everything" },
    ...(builtIn.length > 0
      ? [{ label: "Built in", options: builtIn.map(option) }]
      : []),
    ...(added.length > 0
      ? [{ label: "Added by apps and you", options: added.map(option) }]
      : []),
  ];
}

export function exportPage(storage: Storage) {
  const router = new Hono<AppEnv>();
  router.get("/export", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, []);
    const { count, total_size_bytes: bytes } = await storage.blobs.count();
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    return c.html(
      renderExportPage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        types: await typeOptions(storage),
        files:
          count === 0
            ? "No files"
            : `${String(count)} ${count === 1 ? "file" : "files"}, ${sizeWords(bytes)}`,
        signInLeft: signInLeft(c),
      }),
    );
  });
  return router;
}
