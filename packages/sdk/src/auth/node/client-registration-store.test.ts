/**
 * The contract between the two stores that share one slot.
 *
 * `~/.marfa/<instance>.json` holds a registration and a session side by side
 * in `oauth`, written by different objects that know nothing about each
 * other. Every test here pins the same property from one side or the other:
 * **neither store may destroy the other's data.** The CLI used to delete the
 * whole slot to repair a registration, which signed the person out to fix
 * something that was not their session.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_REGISTRATION_EPOCH } from "../client-registration.js";
import { FileClientRegistrationStore } from "./client-registration-store.js";
import { FileTokenStorage } from "./file-token-storage.js";
import { readConfigFile } from "./config-file.js";

const ISSUER = "https://marfa.example";

describe("FileClientRegistrationStore", () => {
  let dir: string;
  let path: string;
  let store: FileClientRegistrationStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "marfa-reg-"));
    path = join(dir, "default.json");
    store = new FileClientRegistrationStore({ path });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const record = {
    clientId: "client-a",
    issuer: ISSUER,
    claimedScope: "openid items.read",
    epoch: CLIENT_REGISTRATION_EPOCH,
  };

  it("round-trips a registration", async () => {
    await store.write(record);
    expect(await store.read(ISSUER)).toEqual(record);
  });

  it("reads nothing when the file does not exist", async () => {
    expect(await store.read(ISSUER)).toBeNull();
  });

  it("will not hand one instance's registration to another", async () => {
    await store.write(record);
    expect(await store.read("https://other.example")).toBeNull();
  });

  it("treats a record written before epochs as pre-epoch", async () => {
    // What every install affected by the hosted move is holding.
    await store.write(record);
    const file = await readConfigFile(path);
    delete file?.oauth?.registration_epoch;
    await new FileClientRegistrationStore({ path }).write({
      ...record,
      epoch: 0,
    });
    expect((await store.read(ISSUER))?.epoch).toBe(0);
  });

  it("keeps the session when the registration is retired", async () => {
    // **The property the whole file exists for.**
    await store.write(record);
    const tokens = new FileTokenStorage({
      path,
      clientId: record.clientId,
      issuer: ISSUER,
    });
    await tokens.set("ignored", '{"access_token":"at"}');

    await store.clear(ISSUER);

    expect(await tokens.get()).toBe('{"access_token":"at"}');
    // And the record is unusable, so the next resolve registers afresh.
    const after = await store.read(ISSUER);
    expect(after?.claimedScope).toBe("");
  });

  it("leaves a file with no registration well-formed", async () => {
    await store.write(record);
    await store.clear(ISSUER);
    const file = await readConfigFile(path);
    // A reader wanting only the token blob still finds a valid slot rather
    // than one with blanked required fields.
    expect(file?.oauth?.client_id).toBe("client-a");
    expect(file?.oauth?.issuer).toBe(ISSUER);
  });

  it("ignores a clear aimed at a different instance", async () => {
    await store.write(record);
    await store.clear("https://other.example");
    expect(await store.read(ISSUER)).toEqual(record);
  });
});

describe("FileTokenStorage beside a registration", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "marfa-tok-"));
    path = join(dir, "default.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const record = {
    clientId: "client-a",
    issuer: ISSUER,
    claimedScope: "openid items.read",
    epoch: CLIENT_REGISTRATION_EPOCH,
  };

  it("persisting tokens does not erase the recorded ceiling", async () => {
    // **This mints an abandoned client per sign-in when it regresses.** The
    // slot is replaced wholesale on write, so rebuilding it from the token
    // side dropped the scope claim, the next sign-in read that as a stale
    // registration, and the repair registered again.
    const store = new FileClientRegistrationStore({ path });
    await store.write(record);

    const tokens = new FileTokenStorage({
      path,
      clientId: record.clientId,
      issuer: ISSUER,
    });
    await tokens.set("ignored", '{"access_token":"at"}');

    expect(await store.read(ISSUER)).toEqual(record);
  });

  it("signing out keeps the registration", async () => {
    // A session ending says nothing about whether the client is still good,
    // and re-registering on every sign-out leaves a row nothing can revoke.
    const store = new FileClientRegistrationStore({ path });
    await store.write(record);
    const tokens = new FileTokenStorage({
      path,
      clientId: record.clientId,
      issuer: ISSUER,
    });
    await tokens.set("ignored", '{"access_token":"at"}');

    await tokens.delete();

    expect(await tokens.get()).toBeNull();
    expect(await store.read(ISSUER)).toEqual(record);
  });
});
