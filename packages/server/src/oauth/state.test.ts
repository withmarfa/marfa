import { describe, it, expect } from "vitest";
import {
  signOAuthState,
  verifyOAuthState,
  DEFAULT_STATE_TTL_MS,
} from "./state.js";

describe("OAuth callback state", () => {
  it("round-trips through sign + verify", () => {
    const state = signOAuthState({
      connection_id: "conn_x",
      redirect_uri: "https://marfa.so/oauth/callback",
    });
    const result = verifyOAuthState(state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.connection_id).toBe("conn_x");
      expect(result.envelope.redirect_uri).toBe(
        "https://marfa.so/oauth/callback",
      );
    }
  });

  it("each call produces a distinct ciphertext (nonce randomness)", () => {
    const a = signOAuthState({
      connection_id: "conn_x",
      redirect_uri: "https://r/",
    });
    const b = signOAuthState({
      connection_id: "conn_x",
      redirect_uri: "https://r/",
    });
    expect(a).not.toBe(b);
  });

  it("rejects an expired state", () => {
    const state = signOAuthState({
      connection_id: "conn_x",
      redirect_uri: "https://r/",
      ttl_ms: 1000,
      now_ms: 0,
    });
    const result = verifyOAuthState(state, DEFAULT_STATE_TTL_MS + 5000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects a tampered state ciphertext", () => {
    const state = signOAuthState({
      connection_id: "conn_x",
      redirect_uri: "https://r/",
    });
    // Flip a hex character to invalidate the AES-GCM tag.
    const tampered = state.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    const result = verifyOAuthState(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("rejects garbage input as invalid (not malformed)", () => {
    const result = verifyOAuthState("not-a-real-state");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });
});
