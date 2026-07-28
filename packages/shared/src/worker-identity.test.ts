/**
 * Per-Worker identity derivation.
 *
 * The security property is that two Workers never share a key, and the
 * operational property is that a shell script can derive the same value
 * `openssl dgst -sha256 -hmac` produces. Both are pinned here, the
 * second by a literal vector rather than by re-deriving through another
 * HMAC call — a test that computes the expected value the same way the
 * implementation does agrees with any implementation, including one
 * that has drifted from what the provisioning script writes.
 */
import { describe, it, expect } from "vitest";
import {
  deriveWorkerIdentityKey,
  INTEGRATION_NAME_HEADER,
} from "./worker-identity.js";

const ROOT = "marfa-root-secret-test-vector";

describe("deriveWorkerIdentityKey", () => {
  it("matches HMAC-SHA256 hex over the name, as openssl computes it", async () => {
    // `printf '%s' google.calendar | openssl dgst -sha256 -hmac <root> -hex`.
    // The provisioning script derives each Worker's secret that way, so
    // a change here that leaves the fleet unable to authenticate has to
    // fail a test rather than a deploy.
    expect(await deriveWorkerIdentityKey(ROOT, "google.calendar")).toBe(
      "583ca26c9f9c02890d0a5401706082fd44c138625b7e433449ed4a23d8a37f1f",
    );
    expect(await deriveWorkerIdentityKey(ROOT, "withmarfa.rss-watcher")).toBe(
      "01de2cef909cdafce8be45c0a3777d014dfa6d0df942b90d9c63a448a0df6219",
    );
  });

  it("is deterministic", async () => {
    const a = await deriveWorkerIdentityKey(ROOT, "google.tasks");
    const b = await deriveWorkerIdentityKey(ROOT, "google.tasks");
    expect(a).toBe(b);
  });

  it("gives each integration a different key", async () => {
    // The whole point: a credential minted for one Worker is not usable
    // by another, because the other cannot present the first's key.
    const names = [
      "google.calendar",
      "google.tasks",
      "google.drive",
      "readwise",
      "raindrop.bookmarks",
    ];
    const keys = await Promise.all(
      names.map((n) => deriveWorkerIdentityKey(ROOT, n)),
    );
    expect(new Set(keys).size).toBe(names.length);
  });

  it("gives each root a different key for the same integration", async () => {
    const staging = await deriveWorkerIdentityKey(ROOT, "google.calendar");
    const prod = await deriveWorkerIdentityKey(
      `${ROOT}-prod`,
      "google.calendar",
    );
    // Environments hold separate roots, so a staging Worker's secret is
    // not a production Worker's secret even for the same integration.
    expect(staging).not.toBe(prod);
  });

  it("refuses an empty root secret", async () => {
    // `HMAC("", name)` is a valid tag, identical across every deployment
    // that forgot the secret, and computable by anyone. Failing loud is
    // the only safe answer.
    await expect(
      deriveWorkerIdentityKey("", "google.calendar"),
    ).rejects.toThrow(/root secret/);
  });

  it("refuses an empty integration name", async () => {
    await expect(deriveWorkerIdentityKey(ROOT, "")).rejects.toThrow(
      /integration name/,
    );
  });

  it("names the header in lowercase", () => {
    // Header lookup is case-insensitive through `Headers`, but the
    // control plane and the Worker both write this constant into a
    // literal record where it is not, so the canonical spelling is part
    // of the contract.
    expect(INTEGRATION_NAME_HEADER).toBe(INTEGRATION_NAME_HEADER.toLowerCase());
  });
});
