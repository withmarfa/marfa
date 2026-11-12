import { afterEach, expect, it, vi } from "vitest";
import { authenticateOwner } from "../client/owner-session.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const OWNER = { email: "owner@example.test", password: "test-password" };

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
