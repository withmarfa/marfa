import { describe, it, expect } from "vitest";
import { PerEmailThrottle } from "./per-email-throttle.js";

/**
 * Wave C PR3 / T-033 — per-email throttle. Tests cover:
 *   - basic count + cap behaviour
 *   - lowercase normalisation
 *   - window expiry resets the counter
 *   - reset() drops state
 */

describe("PerEmailThrottle", () => {
  it("allows up to `limit` attempts in a window", () => {
    const t = new PerEmailThrottle({ limit: 3, windowMs: 60_000 });
    const now = 1_000_000;
    const a = t.attempt("alice@example.com", now);
    const b = t.attempt("alice@example.com", now + 100);
    const c = t.attempt("alice@example.com", now + 200);
    const d = t.attempt("alice@example.com", now + 300);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(true);
    expect(d.allowed).toBe(false);
    expect(d.count).toBe(3);
    expect(d.limit).toBe(3);
  });

  it("normalises email to lowercase so casing doesn't defeat the cap", () => {
    const t = new PerEmailThrottle({ limit: 2, windowMs: 60_000 });
    const now = 1_000_000;
    expect(t.attempt("Alice@Example.com", now).allowed).toBe(true);
    expect(t.attempt("alice@example.com", now + 100).allowed).toBe(true);
    expect(t.attempt("ALICE@EXAMPLE.COM", now + 200).allowed).toBe(false);
  });

  it("resets the counter once the window has elapsed", () => {
    const t = new PerEmailThrottle({ limit: 2, windowMs: 1000 });
    const now = 1_000_000;
    expect(t.attempt("alice@example.com", now).allowed).toBe(true);
    expect(t.attempt("alice@example.com", now + 100).allowed).toBe(true);
    expect(t.attempt("alice@example.com", now + 500).allowed).toBe(false);
    // After window expiry — fresh window.
    expect(t.attempt("alice@example.com", now + 1500).allowed).toBe(true);
    expect(t.attempt("alice@example.com", now + 1600).allowed).toBe(true);
  });

  it("each email has an independent window", () => {
    const t = new PerEmailThrottle({ limit: 1, windowMs: 60_000 });
    const now = 1_000_000;
    expect(t.attempt("alice@example.com", now).allowed).toBe(true);
    expect(t.attempt("alice@example.com", now + 100).allowed).toBe(false);
    // Different email — fresh counter.
    expect(t.attempt("bob@example.com", now + 200).allowed).toBe(true);
  });

  it("reset() drops state for a single email", () => {
    const t = new PerEmailThrottle({ limit: 1, windowMs: 60_000 });
    const now = 1_000_000;
    expect(t.attempt("alice@example.com", now).allowed).toBe(true);
    expect(t.attempt("alice@example.com", now + 100).allowed).toBe(false);
    t.reset("alice@example.com");
    expect(t.attempt("alice@example.com", now + 200).allowed).toBe(true);
  });

  it("reset() with no argument clears every entry", () => {
    const t = new PerEmailThrottle({ limit: 1, windowMs: 60_000 });
    t.attempt("alice@example.com");
    t.attempt("bob@example.com");
    expect(t.size()).toBe(2);
    t.reset();
    expect(t.size()).toBe(0);
  });
});
