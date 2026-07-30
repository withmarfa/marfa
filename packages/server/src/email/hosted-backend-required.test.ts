/**
 * A hosted instance must not boot with an email transport that cannot send.
 *
 * `none` is the right default for a self-host with no mail provider: the
 * instance runs and its email-dependent flows fail per request. It is the
 * wrong state for a hosted instance, because hosted sign-up is gated on email
 * verification, so a transport that cannot send makes account creation
 * impossible rather than degraded.
 *
 * Refusing at boot is the only place that failure is legible. Nothing
 * downstream reports it: sends are best-effort, and the magic-link route
 * answers "check your email" whether or not anything was sent, which is also
 * what enumeration resistance requires of it. An instance in this state looks
 * healthy from every angle and cannot create a user.
 *
 * The hosted deploy does set the backend, in the container Worker's `envVars`
 * rather than in `wrangler.jsonc`. This guards the case that config does not
 * cover: anything else running `AUTH_MODE=hosted` without one.
 */
import { describe, it, expect } from "vitest";
import { createEmailTransport } from "./index.js";

const FROM = "Marfa <hello@mail.marfa.so>";

describe("a hosted instance requires a transport that can send", () => {
  it("REGRESSION: refuses to boot hosted with the none backend", async () => {
    await expect(
      createEmailTransport({ backend: "none", authMode: "hosted", from: FROM }),
    ).rejects.toThrow(/cannot send|MARFA_EMAIL_BACKEND/i);
  });

  it("names the variable to set, since the failure is otherwise silent", async () => {
    // The operator reading this has a sign-up that stalls and no other clue.
    // The message has to carry the fix, not just the diagnosis.
    let caught: Error | null = null;
    try {
      await createEmailTransport({
        backend: "none",
        authMode: "hosted",
        from: FROM,
      });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain("MARFA_EMAIL_BACKEND");
    expect(caught?.message).toMatch(/cloudflare/);
    expect(caught?.message).toMatch(/smtp/);
  });

  it("still allows the none backend for a keys-mode self-host", async () => {
    // `none` is a legitimate default there: a self-host with no mail provider
    // should run, and its email-dependent flows fail loudly per request rather
    // than blocking boot. Only hosted sign-up depends on delivery.
    const transport = await createEmailTransport({
      backend: "none",
      authMode: "keys",
      from: FROM,
    });
    const result = await transport.send({
      to: "someone@example.com",
      subject: "x",
      html: "<p>x</p>",
      text: "x",
      idempotencyKey: "keys-mode-none-backend",
    });
    expect(result.ok).toBe(false);
  });

  it("allows none when the caller states no auth mode", async () => {
    // Tests and tools construct a transport without describing a deployment.
    // Refusing there would break them for no safety gain.
    const transport = await createEmailTransport({
      backend: "none",
      from: FROM,
    });
    expect(transport).toBeDefined();
  });
});
