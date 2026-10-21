/**
 * Where the image keeps an instance's database replica, and which replica a
 * fresh volume restores: the instance chapter's `instance/replica-*` rules.
 * `harness.ts` says what each boot runs and what it needs.
 *
 * It writes under a prefix of its own and under the default prefix's `db/`,
 * and removes both at the end.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PREFIX,
  boot as bootOn,
  closeBucket,
  keysUnder,
  newVolume,
  openBucket,
  removeUnder,
  replicaAt,
} from "./harness.js";

const run = `replica-paths/${randomBytes(4).toString("hex")}`;

beforeAll(async () => {
  openBucket();
  // `db/` at the bucket's root belongs to no instance, so a key there is one
  // this fixture should not find.
  await removeUnder("db/");
  await removeUnder(`${DEFAULT_PREFIX}/db/`);
});

afterAll(async () => {
  await closeBucket([`${run}/`, `${DEFAULT_PREFIX}/db/`]);
});

/** Boots the instance `name` on a new, empty volume. */
const boot = (name: string, prefix: string | undefined) =>
  bootOn(newVolume(), name, prefix);

/** Boots an instance on a fresh volume, waits for its replica, stops it. */
async function seed(name: string, prefix: string | undefined, replica: string) {
  const instance = await boot(name, prefix);
  expect(instance.bootedAs).toBe("fresh");
  await replicaAt(replica);
  expect(await instance.stop()).toBe(0);
}

describe("deploy/litestream.yml and deploy/entrypoint.sh", () => {
  it("streams the database under the default prefix's db when S3_PREFIX is unset, and a fresh volume restores it", async () => {
    await seed("default", undefined, `${DEFAULT_PREFIX}/db`);
    const keys = await keysUnder(`${DEFAULT_PREFIX}/`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith(`${DEFAULT_PREFIX}/db/`))).toBe(
      true,
    );
    expect(await keysUnder("db/")).toEqual([]);

    const again = await boot("default-again", undefined);
    expect(again.serverPrefix).toBe(DEFAULT_PREFIX);
    expect(again.bootedAs).toBe("default");
    expect(await again.stop()).toBe(0);
  });

  it("keeps the replicas of two instances on one bucket apart, and each fresh volume restores only its own", async () => {
    // One prefix holds the other, which is as close as two instances'
    // prefixes come.
    const own = run;
    const trial = `${run}/rehearsal/blobs`;

    await seed("own", own, `${own}/db`);
    // The witness: the bucket holds a replica, and this volume would restore
    // it if the path were shared.
    expect((await keysUnder(`${own}/db/`)).length).toBeGreaterThan(0);

    const trialFirst = await boot("trial", trial);
    expect(trialFirst.serverPrefix).toBe(trial);
    expect(trialFirst.bootedAs).toBe("fresh");
    await replicaAt(`${trial}/db`);
    expect(await trialFirst.stop()).toBe(0);

    const ownAgain = await boot("own-again", own);
    expect(ownAgain.bootedAs).toBe("own");
    expect(await ownAgain.stop()).toBe(0);

    const trialAgain = await boot("trial-again", trial);
    expect(trialAgain.bootedAs).toBe("trial");
    expect(await trialAgain.stop()).toBe(0);

    // Nothing of either instance's replica is anywhere but under its prefix.
    const everything = await keysUnder(`${run}/`);
    expect(
      everything.filter(
        (key) =>
          !key.startsWith(`${own}/db/`) && !key.startsWith(`${trial}/db/`),
      ),
    ).toEqual([]);
  });

  it("reads a prefix with a slash at either end as the same prefix, for the replica and for the server", async () => {
    const prefix = `${run}/slashes`;
    await seed("slashes", `${prefix}/`, `${prefix}/db`);
    expect(await keysUnder(`${prefix}//`)).toEqual([]);

    for (const spelling of [prefix, `/${prefix}`, `/${prefix}/`]) {
      const again = await boot("slashes-again", spelling);
      expect(again.serverPrefix).toBe(prefix);
      expect(again.bootedAs).toBe("slashes");
      expect(await again.stop()).toBe(0);
    }
  });
});
