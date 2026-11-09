import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackKey } from "../../utils/setup.js";
import { cliContext, releaseHeld, unique } from "./harness.js";
import type { CliContext } from "./harness.js";

/** Sign-ins from the terminal, through the private socket alone. */

let c: CliContext;

beforeAll(async () => {
  c = await cliContext("sign-ins");
});

afterAll(async () => {
  releaseHeld();
  await cleanup(c.ctx);
});

describe("the sign-ins from the terminal", () => {
  it("lists, renames and ends a sign-in through the private socket, and refuses an ordinary key", async () => {
    const socket = process.env.MARFA_CONTROL_SOCKET;
    expect(
      socket,
      "the fixture exposes its private control socket",
    ).toBeTruthy();
    const local = c.cli.viaSocket(socket!);
    const label = unique("cli-sign-in");
    const minted = await local.json<{ id: string; key: string }>([
      "keys",
      "create",
      "--label",
      label,
      "--source",
      unique("cli-sign-in-source"),
      "--type-permission",
      "core.note=read",
    ]);
    trackKey(c.ctx, minted.id);
    const holder = c.cli.as(minted.key);
    // The witness: the key reaches the server before it is ended.
    await holder.json(["keys", "current"]);

    interface SignIn {
      id: string;
      kind: string;
      name: string;
    }
    const listed = await local.json<{ data: SignIn[] }>(["sign-ins", "list"]);
    expect(listed.data.find((row) => row.id === minted.id)).toMatchObject({
      kind: "key",
      name: label,
    });
    expect(listed.data.every((row) => !("current" in row))).toBe(true);
    const plain = await local.run(["sign-ins", "list"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(`${minted.id}  key      ${label}`);

    const renamed = await local.json<SignIn>([
      "sign-ins",
      "rename",
      minted.id,
      `${label} renamed`,
    ]);
    expect(renamed).toMatchObject({ id: minted.id, name: `${label} renamed` });

    for (const ordinary of [c.cli, c.operator]) {
      const refused = await ordinary.refused(["sign-ins", "list"]);
      expect(refused.code).toBe(1);
      expect(refused.envelope.error.server?.code).toBe("forbidden");
    }

    expect(await local.json(["sign-ins", "end", minted.id])).toEqual({
      ok: true,
    });
    const after = await holder.refused(["keys", "current"]);
    expect(after.code).toBe(5);
    expect(after.envelope.error.server?.status).toBe(401);
    const again = await local.refused(["sign-ins", "end", minted.id]);
    expect(again.code).toBe(1);
    expect(again.envelope.error.server?.code).toBe("sign_in_not_found");
  });
});
