import { afterEach, expect, it } from "vitest";
import { copyLiveReplay, refusal } from "../../device/marfa-answers.js";
import {
  bindingFolderHarness,
  type BindingFolderHarness,
} from "./binding-folders.shared.js";
import { put } from "./folders.shared.js";

let harness: BindingFolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

it("tells an app why links by name wait when the server has no title lookup, and no longer once it has", async () => {
  // A server older than `POST /items/titles` answers it as no route.
  let upgraded = false;
  harness = await bindingFolderHarness("binding-folder-lookup-refused", {
    events: [copyLiveReplay("1", [])],
    lookup: () =>
      upgraded ? undefined : refusal(404, "not_found", "Not found"),
  });
  put(harness, "Ticket.md", "See [[Target]].\n");
  expect((await harness.bound.testOpen()).ok).toBe(true);

  const old = await harness.bound.testScan();
  expect(old.ok, JSON.stringify(old)).toBe(true);
  if (!old.ok) return;
  expect(
    old.value.lookupRefused,
    "the scan waited on a lookup with no reason an app can show",
  ).toContain("no title lookup");

  // The witness: the same folder, unedited, reports no refusal once the
  // server has the lookup.
  upgraded = true;
  const now = await harness.bound.testScan();
  expect(now.ok, JSON.stringify(now)).toBe(true);
  if (!now.ok) return;
  expect(now.value.lookupRefused).toBeUndefined();
});
