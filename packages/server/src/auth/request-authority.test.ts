import { expect, it } from "vitest";
import {
  rememberRecentAuthentication,
  validateRequestAuthority,
  withRequestAuthority,
  type RecentSignIn,
} from "./request-authority.js";

/** What the write transaction is told to ask, after `check` has run. */
async function askedAfter(
  check: () => void,
): Promise<RecentSignIn | undefined> {
  let asked: RecentSignIn | undefined;
  await withRequestAuthority(
    (_permissions, recent) => {
      asked = recent;
      return Promise.resolve();
    },
    async () => {
      check();
      await validateRequestAuthority();
    },
  );
  return asked;
}

it("asks nothing about the sign-in of a request that never checked it", async () => {
  expect(await askedAfter(() => undefined)).toBeUndefined();
});

it("has the transaction judge a check at the moment the check named", async () => {
  expect(
    await askedAfter(() => {
      rememberRecentAuthentication(1000);
    }),
  ).toEqual({ at: 1000 });
});

it("has the transaction judge a check that named no moment when the transaction opens", async () => {
  expect(
    await askedAfter(() => {
      rememberRecentAuthentication();
    }),
  ).toEqual({ at: undefined });
});

it("lets a check that named no moment outweigh one that did, in either order", async () => {
  expect(
    await askedAfter(() => {
      rememberRecentAuthentication(1000);
      rememberRecentAuthentication();
    }),
  ).toEqual({ at: undefined });
  expect(
    await askedAfter(() => {
      rememberRecentAuthentication();
      rememberRecentAuthentication(1000);
    }),
  ).toEqual({ at: undefined });
});

it("judges two checks that named a moment at the later one", async () => {
  expect(
    await askedAfter(() => {
      rememberRecentAuthentication(1000);
      rememberRecentAuthentication(3000);
      rememberRecentAuthentication(2000);
    }),
  ).toEqual({ at: 3000 });
});
