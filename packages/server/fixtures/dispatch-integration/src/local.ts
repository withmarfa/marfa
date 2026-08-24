/**
 * The integration the server image dispatches through to prove that
 * `@withmarfa/runtime-sdk` resolves to exactly one copy inside the built
 * image.
 *
 * **Why a whole package rather than a test file.** The property under test
 * is a bundling property: the server bundle and an integration's
 * `dist/local.js` have to resolve the same module instance of the runtime
 * kit, because the handler `REGISTRY` is module-singleton state. When they
 * do not, the handler registers into one registry and the dispatch reads
 * another, and the only symptom is a dispatch that comes back
 * `no_schedule_handler_registered` — handler registration breaking
 * invisibly. Nothing running under vitest can observe that: every test goes
 * through the executor's `directDispatch` seam, and there is one module
 * graph either way. The only fixture that can observe it is one built the
 * way a real integration is built and staged the way a real integration is
 * staged. A fixture bundled differently proves something about that other
 * way of bundling.
 *
 * **Why the server owns it.** It tests this repository's image bundling,
 * so it belongs to the server rather than to the integration set. It also
 * has to stay invisible to the runtime's own discovery, and sitting
 * outside `MARFA_INTEGRATIONS_ROOT` entirely is a stronger guarantee of
 * that than a directory-name prefix the discovery happens to skip. The
 * image stages it to `/verify-fixtures`, and deletes it once the
 * verification has passed, so nothing running in the container can
 * mistake it for something a deployment installed.
 *
 * **What it has to keep doing.** Three callers drive it, and between them
 * they pin every observable below.
 *
 *   - `packages/server/scripts/verify-image-integrations.mjs`, inside the
 *     image, and `packages/server/scripts/smoke-worker-entry.ts`, against
 *     the monorepo. Both spawn the built `worker-entry.js`, which imports
 *     this module and relies on the load-time registration at the bottom;
 *     both assert one schedule dispatch comes back ok, and the smoke also
 *     asserts a cursor delta arrives under `cursor:main`.
 *   - `src/integrations/local-runtime/substrate-smoke.test.ts`, which drives
 *     the supervisor rather than a worker thread. It calls the exported
 *     `registerHandlers` itself after resetting the registry, and asserts
 *     the persisted cursor carries `run_count`. That is the only reason
 *     `registerHandlers` is exported and the only reader of that field.
 *
 * All three stand up something that answers a POST with a created item,
 * which is what the activity emit below needs and the whole of what it may
 * need: a handler here that wanted a real Marfa would make the check
 * untestable in the one place it has to run.
 */
import {
  registerScheduleHandler,
  type ConnectionContext,
  type ScheduleMessage,
  type HandlerResult,
} from "@withmarfa/runtime-sdk";

interface FixtureCursor {
  /** ISO timestamp of the dispatch that last advanced this cursor. */
  last_run_at: string;
  /** Dispatches seen against this connection. */
  run_count: number;
}

/**
 * `cursor:main` is what the callers assert on, so the key is part of the
 * contract with them rather than an implementation detail — the runtime
 * kit's `createCursorStore` prefixes user keys with `cursor:`.
 */
const CURSOR_KEY = "main";

/**
 * A schema-valid manifest, because the verification's own manifest check
 * imports this entry alongside every staged integration and holds them all
 * to the same three fields the server's catalog loader requires. The
 * publisher is the repository's placeholder handle rather than `marfa`:
 * this identifier never enters a catalog, and one that reads like a real
 * Marfa integration would be the kind of thing somebody later tries to
 * install.
 */
export const DISPATCH_FIXTURE_MANIFEST = {
  name: "acme/dispatch-fixture",
  version: "0.1.0",
  publisher: "acme",
  description:
    "Not an integration. The fixture the server image dispatches through to prove the runtime kit resolves to a single copy inside the image.",
  manifest_schema_version: "2.0.0",
  direction: "read" as const,
  target_types: ["core.note"] as const,
  triggers: [
    {
      type: "schedule" as const,
      config: { cron: "*/5 * * * *" },
    },
  ] as const,
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "state-trashed" as const,
    partial_write_mode: "all-or-nothing" as const,
  },
  oauth_requirements: {} as Record<string, "proxy" | "leased">,
  webhook_verification: { method: "hmac-sha256" as const },
  permissions: {
    extension: { "connection.runtime": "write" as const },
    edge: {},
  },
};

/**
 * One schedule handler and nothing else. Every surface it touches — the
 * cursor store, the activity sink, the connection client underneath the
 * sink — comes from the runtime kit, so a dispatch that completes has
 * exercised the resolution this fixture exists to prove. Handlers for the
 * triggers nothing here dispatches would register into the same registry
 * and demonstrate nothing further.
 */
export async function handleSchedule(
  ctx: ConnectionContext,
  message: ScheduleMessage,
): Promise<HandlerResult> {
  const previous = (await ctx.cursor.read(CURSOR_KEY)) as FixtureCursor | null;
  const next: FixtureCursor = {
    last_run_at: new Date(message.scheduled_for_ms).toISOString(),
    run_count: (previous?.run_count ?? 0) + 1,
  };
  await ctx.cursor.write(CURSOR_KEY, next);

  await ctx.activity.emit({
    severity: "info",
    summary: `Dispatch fixture ran (count=${String(next.run_count)})`,
    detail: { previous: previous?.last_run_at ?? null },
  });

  return { ok: true };
}

/** Seeds the in-thread registry. Exported for callers that reset the
 *  registry between dispatches; called at load time for the worker
 *  thread, which imports this module and nothing else. */
export function registerHandlers(): void {
  registerScheduleHandler(handleSchedule);
}

registerHandlers();

export { DISPATCH_FIXTURE_MANIFEST as manifest };
