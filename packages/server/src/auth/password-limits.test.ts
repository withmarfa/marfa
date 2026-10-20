import { afterEach, expect, it } from "vitest";
import { createTestContext } from "../test-utils.js";
import { PASSWORD_MAX, PASSWORD_MIN } from "./password-limits.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("is the range of passwords the server accepts, and says the range it enforces", async () => {
  const ctx = await createTestContext();
  cleanups.push(ctx.cleanup);
  const account = (password: string) =>
    ctx.auth.createEmailAccount({ email: "range@example.com", password });
  expect(await account("a".repeat(PASSWORD_MIN - 1))).toMatchObject({
    ok: false,
    reason: "password_too_short",
    minLength: PASSWORD_MIN,
  });
  expect(await account("a".repeat(PASSWORD_MAX + 1))).toMatchObject({
    ok: false,
    reason: "password_too_long",
    maxLength: PASSWORD_MAX,
  });
  // Witness: the edges themselves are not refused for length.
  expect(await account("a".repeat(PASSWORD_MIN))).toMatchObject({ ok: true });
  expect(await account("b".repeat(PASSWORD_MAX))).toMatchObject({
    ok: false,
    reason: "email_exists",
  });
});
