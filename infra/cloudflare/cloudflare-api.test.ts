/**
 * What the Worker-surface check does when it cannot read an answer.
 *
 * `getWorkerSubdomain` is the one call behind
 * `scripts/verify-integration-worker-surface.ts`, and that script
 * exists because the repository saying `workers_dev = false` proves
 * nothing about the live fleet. Its verdict comes from
 * `enabled || previews_enabled`, so a response that lost a field would
 * evaluate falsy and report a Worker still serving a public hostname
 * as closed. Reporting closed is the only answer a check like this
 * must never get wrong, so an incomplete response has to be an error
 * rather than a verdict.
 *
 * Pinned here because the failure is silent by construction: today's
 * API returns both flags, so nothing in a passing run would show the
 * difference.
 */
import { describe, it, expect, afterEach } from "vitest";
import { CloudflareClient } from "./cloudflare-api.js";

const SCRIPT = "marfa-integration-example-prod";
const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

/** Answer every request with one canned Cloudflare envelope. */
function stubApi(status: number, body: unknown): void {
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

function envelope(result: unknown): unknown {
  return { success: true, errors: [], messages: [], result };
}

function client(): CloudflareClient {
  return new CloudflareClient({ apiToken: "token", accountId: "account" });
}

describe("getWorkerSubdomain", () => {
  it("reports both flags when the API returns both", async () => {
    stubApi(200, envelope({ enabled: true, previews_enabled: false }));
    await expect(client().getWorkerSubdomain(SCRIPT)).resolves.toEqual({
      enabled: true,
      previews_enabled: false,
    });
  });

  it("reports a script that was never deployed as absent", async () => {
    // A 404 mid-rollout is expected and is not a failure to read.
    stubApi(404, {
      success: false,
      errors: [{ code: 10007, message: "workers.api.error.script_not_found" }],
      messages: [],
      result: null,
    });
    await expect(client().getWorkerSubdomain(SCRIPT)).resolves.toBeUndefined();
  });

  it.each([
    ["neither flag", {}],
    ["only the workers.dev flag", { enabled: false }],
    ["only the preview flag", { previews_enabled: false }],
    ["a null body", null],
    ["flags of the wrong type", { enabled: "false", previews_enabled: 0 }],
  ])("refuses to answer on %s", async (_label, result) => {
    // Not `resolves.toBeUndefined()`: undefined means "no such script",
    // which the caller reports as a legitimate mid-rollout state. An
    // unreadable answer has to be louder than that.
    await expect(async () => {
      stubApi(200, envelope(result));
      return client().getWorkerSubdomain(SCRIPT);
    }).rejects.toThrow(/without both flags/u);
  });
});
