import { applyInlineEdges } from "../routes/_edges-inline.js";
import type { Storage } from "../storage/interface.js";

/**
 * Seed a brand-new space with a few starter items on sign-up so a fresh
 * space demonstrates the typed-data model — distinct item types joined by a
 * typed edge — instead of opening empty.
 *
 * Gated by `MARFA_SEED_STARTER_CONTENT` and called best-effort from the
 * sign-up provisioning hook: the caller swallows any throw so a seed failure
 * can never strand account creation. Writes run on the provisioning hook's
 * owner connection with `spaceId` stamped explicitly — there is no
 * per-request RLS context in the hook, matching how the space and users row
 * are created alongside.
 *
 * Copy is intentionally free of em-dashes, per the house style for
 * user-facing strings.
 */
export async function seedStarterContent(
  storage: Storage,
  spaceId: string,
): Promise<void> {
  // Three core types so the space shows the model at a glance: a note, a
  // bookmark, and a task.
  const welcome = await storage.items.create(
    {
      type: "core.note",
      properties: {
        title: "Welcome to your space",
        body: "Everything in Marfa is a typed item: notes, bookmarks, tasks, people, events. Connect them with edges and they become a graph of your life. This space is yours to fill.",
      },
      tags: ["welcome"],
    },
    spaceId,
  );

  const docs = await storage.items.create(
    {
      type: "core.bookmark",
      properties: {
        title: "Marfa documentation",
        url: "https://docs.marfa.so",
      },
      tags: ["reference"],
    },
    spaceId,
  );

  await storage.items.create(
    {
      type: "core.task",
      properties: { title: "Make your first connection" },
      tags: ["getting-started"],
    },
    spaceId,
  );

  // One typed edge so the space reads as a graph, not a flat list: the
  // welcome note references the docs bookmark. applyInlineEdges validates the
  // proposed set and must run inside a transaction (its delete-then-create
  // needs rollback on a rejected set).
  await storage.runInTransaction(() =>
    applyInlineEdges(
      storage,
      welcome.id,
      { references: [docs.id] },
      spaceId,
      // No permission gate: this runs inside sign-up provisioning, on a
      // space with no credentials yet and no caller to check. Every other
      // call site passes the request's edge-type gate.
      () => undefined,
    ),
  );
}
