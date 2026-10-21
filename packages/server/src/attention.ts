import * as clock from "./clock.js";
import { listFolders } from "./folder-inventory.js";
import { readFolderStatus } from "./folder-status-read.js";
import { endingTitle, endsSoon } from "./pages/key-time.js";
import type { Storage } from "./storage/interface.js";
import type { ConsoleHealth } from "./routes/console-health.js";
import { withinDeadline, type AttentionItem } from "./routes/console.js";
import { PROBE_TIMEOUT_MS } from "./routes/health.js";
import { connectorStatus } from "./routes/connector-status.js";
import { checksFrom, healthAttention } from "./routes/health-page-routes.js";
import { connectorHref, CONNECTORS_HREF } from "./routes/connector-pages.js";
import {
  folderHref,
  FOLDERS_HREF,
  folderReadingLabel,
} from "./routes/folder-pages.js";
import { keyHref, KEYS_HREF } from "./routes/key-pages.js";
import { HEALTH_HREF } from "./routes/health-pages.js";

export interface AttentionConcern extends AttentionItem {
  kind: "health" | "job" | "connector" | "folder" | "key" | "unavailable";
  description: string;
  /** Component or job name, connector/folder/key ID, or unavailable source name. */
  reference: string;
}

const unavailable = (reference: string, href: string): AttentionConcern => ({
  kind: "unavailable",
  reference,
  href,
  tone: "warn",
  title: `Couldn't check ${reference}`,
  description:
    "The check failed or did not answer in time. Its state is unknown.",
});

/** A partial scan keeps its findings even when the remaining source does not answer. */
async function collect(
  reference: string,
  href: string,
  read: (
    add: (item: AttentionConcern) => void,
    active: () => boolean,
  ) => Promise<void>,
  budgetMs = 2000,
): Promise<AttentionConcern[]> {
  const items: AttentionConcern[] = [];
  let active = true;
  try {
    await withinDeadline(
      () =>
        read(
          (item) => {
            if (active) items.push(item);
          },
          () => active,
        ),
      budgetMs,
    );
  } catch {
    items.push(unavailable(reference, href));
  } finally {
    active = false;
  }
  return items;
}

/** The caller must establish owner or private-local authority before reading this inventory. */
export async function readAttention(
  storage: Storage,
  health: ConsoleHealth,
): Promise<AttentionConcern[]> {
  const now = clock.nowMs();
  const groups = await Promise.all([
    collect(
      "Health",
      HEALTH_HREF,
      async (add) => {
        const reading = await health.read();
        for (const check of checksFrom(reading.components, null)) {
          const item = healthAttention([check], [])[0];
          if (item)
            add({
              ...item,
              kind: "health",
              reference: check.name,
              description: item.description ?? item.title,
            });
        }
      },
      PROBE_TIMEOUT_MS + 500,
    ),
    collect(
      "Object store",
      HEALTH_HREF,
      async (add) => {
        const check = await health.objectStore();
        if (check) {
          const item = healthAttention(
            [{ name: "object_store", status: check.status }],
            [],
          )[0];
          if (item)
            add({
              ...item,
              kind: "health",
              reference: "object_store",
              description: item.description ?? item.title,
            });
        }
      },
      PROBE_TIMEOUT_MS + 500,
    ),
    collect("Housekeeping", HEALTH_HREF, async (add) => {
      for (const job of await health.jobs()) {
        const item = healthAttention([], [job])[0];
        if (item)
          add({
            ...item,
            kind: "job",
            reference: job.name,
            description: item.description ?? "The last run failed.",
          });
      }
    }),
    collect("Connectors", CONNECTORS_HREF, async (add) => {
      for (const connector of await storage.connectors.list()) {
        const { state, tone } = connectorStatus(connector, now);
        if (state === "running") continue;
        add({
          kind: "connector",
          reference: connector.id,
          href: connectorHref(connector.id),
          tone,
          title:
            state === "failing"
              ? `${connector.name} failed its last run`
              : state === "problems"
                ? `${connector.name} reported problems`
                : `${connector.name} has gone quiet`,
          description:
            state === "failing"
              ? (connector.last_run?.error ?? "The last run failed.")
              : state === "problems"
                ? "The connector reports unresolved problems."
                : "Nothing heard for more than a day.",
        });
      }
    }),
    collect("Folders", FOLDERS_HREF, async (add, active) => {
      let cursor: string | undefined;
      do {
        const page = await listFolders(storage, 100, cursor);
        for (const folder of page.data) {
          if (!active()) return;
          try {
            const status = await storage.runInTransaction(() =>
              readFolderStatus(storage, folder.id),
            );
            if (folderReadingLabel(status).tone)
              add({
                kind: "folder",
                reference: folder.id,
                href: folderHref(folder.id),
                tone: "warn",
                title: `${folder.title} needs a look`,
                description:
                  "A current sign-in reports sync problems, paused removals, or a first sync waiting for confirmation.",
              });
          } catch {
            add({
              ...unavailable(folder.id, folderHref(folder.id)),
              title: `Couldn't check ${folder.title}`,
            });
          }
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor && active());
    }),
    collect("API keys", KEYS_HREF, async (add) => {
      for (const key of await storage.keys.list()) {
        const ends = key.expires_at ? Date.parse(key.expires_at) : null;
        if (ends === null || !endsSoon(ends, now)) continue;
        add({
          kind: "key",
          reference: key.id,
          title: endingTitle(key.label, ends, now),
          description: "Scripts using it will stop working",
          href: keyHref(key.id),
          tone: "warn",
        });
      }
    }),
  ]);
  return groups.flat();
}
