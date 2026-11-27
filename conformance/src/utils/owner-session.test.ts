import { afterEach, expect, it, vi } from "vitest";
import { authenticateOwner, signInAnswerOf } from "../client/owner-session.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const OWNER = { username: "owner", password: "test-password" };

function serving(passkeys: number) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/owner/passkeys"))
      return new Response(null, { status: passkeys });
    return new Response(null, {
      status: 302,
      headers: {
        location: "/",
        "set-cookie": "marfa_session=new; Path=/; HttpOnly",
      },
    });
  });
}

it("keeps a cookie the passkey page still admits", async () => {
  const request = serving(200);
  vi.stubGlobal("fetch", request);
  expect(await authenticateOwner("http://instance.test", "old", OWNER)).toBe(
    "old",
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it("signs in again for a cookie that has ended", async () => {
  const request = serving(401);
  vi.stubGlobal("fetch", request);
  expect(await authenticateOwner("http://instance.test", "old", OWNER)).toBe(
    "marfa_session=new",
  );
  expect(request).toHaveBeenCalledTimes(2);
});

it("stops on any other answer to the check", async () => {
  vi.stubGlobal("fetch", serving(500));
  await expect(
    authenticateOwner("http://instance.test", "old", OWNER),
  ).rejects.toThrow("answered 500");
});

it("stops on a sign-in the form sends back with an error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("/owner/passkeys"))
        return Promise.resolve(new Response(null, { status: 401 }));
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "/auth/sign-in?error=invalid_credentials" },
        }),
      );
    }),
  );
  await expect(
    authenticateOwner("http://instance.test", "old", OWNER),
  ).rejects.toThrow("refused");
});

it("reads the error and the wait a sign-in form's redirect carries", () => {
  const limited = new Response(null, {
    status: 302,
    headers: {
      location:
        "/auth/sign-in?error=too_many_attempts&retry_after_seconds=90&username=owner",
    },
  });
  expect(signInAnswerOf(limited)).toEqual({
    status: 302,
    location:
      "/auth/sign-in?error=too_many_attempts&retry_after_seconds=90&username=owner",
    error: "too_many_attempts",
    wait: 90,
  });
  const signedIn = new Response(null, {
    status: 302,
    headers: { location: "/" },
  });
  expect(signInAnswerOf(signedIn)).toMatchObject({
    error: undefined,
    wait: undefined,
  });
});
