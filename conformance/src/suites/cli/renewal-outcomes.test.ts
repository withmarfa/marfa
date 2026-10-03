import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Cli } from "./harness.js";
import { keychainEnv } from "../../utils/keychain.js";
import { answers, wireItem } from "../../device/marfa-answers.js";
import {
  hydratedHarness,
  KEY,
  requireBinary,
  scriptWrites,
  type Harness,
} from "../device/harness.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});
const id = "01a00000-0000-7000-8000-00000000000a";
async function prepared() {
  harness = await hydratedHarness("cli-outcomes", {
    rows: {
      "core.note": [
        {
          item: { id, version: 3, properties: { title: "held", body: "held" } },
        },
      ],
    },
  });
  expect(
    (
      await harness.device.update(id, {
        properties: { title: "edit" },
        version: 3,
      })
    ).ok,
  ).toBe(true);
  return { ...harness, cli: new Cli(requireBinary(), harness.server.url, KEY) };
}

describe("renewal CLI outcomes", () => {
  it.runIf(process.platform === "darwin")(
    "keeps prior answers when a later renewal ends locally",
    async () => {
      const h = await prepared();
      expect(
        (
          await h.device.create({
            type: "core.note",
            properties: { title: "later", body: "preserve this" },
          })
        ).ok,
      ).toBe(true);
      const before = await h.device.queue();
      expect(before.ok).toBe(true);
      if (!before.ok) throw new Error("queue refused");
      scriptWrites(h.server, {
        update: [
          answers.updated(
            wireItem({
              id,
              version: 4,
              properties: { title: "edit", body: "held" },
            }),
          ),
        ],
        create: [answers.unauthorized()],
      });
      h.server.answer(
        "POST",
        "/token",
        answers.validation("invalid_grant", "fixture ended"),
      );
      execFileSync("security", [
        "add-generic-password",
        "-A",
        "-s",
        "marfa",
        "-a",
        h.server.url,
        "-w",
        JSON.stringify({
          kind: "token",
          access_token: "marfa_at_fixture",
          refresh_token: "marfa_rt_fixture",
          expires_at: null,
          client_id: "fixture",
          scope: "*:read",
          token_endpoint: `${h.server.url}/token`,
          revocation_endpoint: null,
        }),
        keychainEnv().MARFA_KEYCHAIN!,
      ]);
      const result = await h.cli
        .as(undefined)
        .run(["--json", "device", "--db", h.device.store, "drain"]);
      expect(result.code, JSON.stringify(result)).toBe(5);
      expect(result.stdout).toBe("");
      const envelope = JSON.parse(result.stderr);
      expect(envelope.error.code).toBe("signed_out");
      expect(envelope.error.server).toBeNull();
      const after = await h.device.queue();
      expect(after.ok).toBe(true);
      if (!after.ok) throw new Error("queue refused");
      expect(after.value[0]?.verdict).toBe("accepted");
      expect(after.value[0]?.answered_at).toBeTruthy();
      expect(after.value[1]).toEqual(before.value[1]);
      expect(after.value[1]?.refusals).toBe(0);
      expect(after.value[1]?.verdict).toBeNull();
      const first = await h.device.get(id);
      expect(first.ok && first.value.version).toBe(4);
    },
  );
});
