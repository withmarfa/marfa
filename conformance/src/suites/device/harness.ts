import { CliDevice, newStore } from "../../device/cli-adapter.js";
import { ScriptedServer } from "../../device/scripted-server.js";
import {
  headRead,
  itemsPage,
  typeCatalog,
  wireItem,
  type WireItemOptions,
} from "../../device/marfa-answers.js";

/**
 * A device and the server it talks to, both under the fixture's control.
 *
 * The device is the `marfa` binary. There is no second implementation here
 * and there is not meant to be: a fixture that agreed with a reference device
 * would be two of this suite's own opinions agreeing with each other.
 */

export const KEY = "device-fixture-key";

export function requireBinary(): string {
  const binary = process.env.MARFA_DEVICE_BIN;
  if (binary === undefined || binary === "") {
    throw new Error(
      "MARFA_DEVICE_BIN is unset. Build the binary (`cargo build -p marfa-cli` under core/) and point this at it; the conformance job does both.",
    );
  }
  return binary;
}

export interface Harness {
  server: ScriptedServer;
  device: CliDevice;
  stop: () => Promise<void>;
}

export async function startHarness(label: string): Promise<Harness> {
  const server = await ScriptedServer.start();
  const device = new CliDevice({
    binary: requireBinary(),
    store: newStore(label),
    url: server.url,
    key: KEY,
  });
  return {
    server,
    device,
    /**
     * Stopping is also where a door nobody scripted is reported. An unscripted
     * door answers 501, a device reads that as one more refusal, and a fixture
     * then reads it as the refusal it was testing for; this is the one place
     * that difference is visible.
     */
    stop: async () => {
      const unscripted = [...server.unmatchedRequests];
      await server.stop();
      if (unscripted.length > 0) {
        throw new Error(
          `the device went to a door no answer was scripted for, and read the 501 as a refusal: ${unscripted.join(", ")}`,
        );
      }
    },
  };
}

/**
 * The script a plain hydration needs: a head cursor, the catalog, and one page
 * per declared type.
 *
 * Answers for a door are consumed in order and the last one repeats, so a
 * fixture writes the whole sequence before the device runs. Appending an
 * answer after the device has already been through a door queues it behind
 * the one that is still answering, which reads as the new answer being
 * ignored.
 * `rows` is keyed by type, and a type with no entry
 * answers an empty page rather than going unscripted, because an unscripted
 * door answers 501 and the device would report that instead of the thing
 * under test.
 */
export function scriptHydration(
  server: ScriptedServer,
  options: {
    head: string;
    rows?: Record<string, Array<{ item: WireItemOptions; tags?: string[] }>>;
  },
): void {
  const rows = options.rows ?? {};
  server.answer("GET", "/events", headRead(options.head));
  server.answer("GET", "/types", typeCatalog());
  server.answer("GET", "/items", (request) => {
    const type = request.query.get("type") ?? "";
    const forType = rows[type] ?? [];
    // The state parameter is honored rather than ignored, because a
    // scripted server more generous than the real one lets a device that
    // stopped asking for every state stay green while a real copy silently
    // holds only active rows (`device.md` 31). `any` is the only value
    // hydration sends, so anything else narrows the same way the server's
    // listing does.
    const asked = request.query.get("state") ?? "active";
    const visible =
      asked === "any"
        ? forType
        : forType.filter((row) => (row.item.state ?? "active") === asked);
    return itemsPage(
      visible.map((row) => ({ item: wireItem(row.item), tags: row.tags })),
    );
  });
}
