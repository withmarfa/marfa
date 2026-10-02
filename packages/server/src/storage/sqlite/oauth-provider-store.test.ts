/**
 * Revoking a grant's tokens and consent is one transaction: a fault part way
 * leaves every record as it was rather than some of them gone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestContext,
  seedOauthBearer,
  TEST_API_KEY_SALT,
} from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { hashApiKey } from "../../middleware/auth.js";
import { SqliteOauthProviderStore } from "./oauth-provider-store.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = undefined;
});

async function seedGrant(c: TestContext) {
  const oauth = c.storage.oauthProvider;
  if (!oauth) throw new Error("storage.oauthProvider missing");
  const { token, clientId } = await seedOauthBearer(c.storage, [
    "core.note:read",
  ]);
  const accessHash = hashApiKey(
    token.slice("marfa_at_".length),
    TEST_API_KEY_SALT,
  );
  const row = await oauth.validateAccessToken(accessHash);
  const authUserId = row?.userId;
  if (!authUserId) throw new Error("the seeded token has no user");
  await oauth.upsertConsent({
    clientId,
    authUserId,
    scopes: ["core.note:read"],
  });
  const state = async () => ({
    token: (await oauth.validateAccessToken(accessHash)) !== null,
    consent: (await oauth.getPriorConsent(clientId, authUserId)) !== undefined,
  });
  return { oauth, clientId, authUserId, state };
}

describe("revokeTokensForGrant", () => {
  it("deletes the grant's tokens and its consent", async () => {
    ctx = await createTestContext({});
    const { oauth, clientId, authUserId, state } = await seedGrant(ctx);
    expect(await state()).toEqual({ token: true, consent: true });
    await oauth.revokeTokensForGrant(clientId, authUserId);
    expect(await state()).toEqual({ token: false, consent: false });
  });

  it("deletes nothing when a step fails part way", async () => {
    ctx = await createTestContext({});
    const { oauth, clientId, authUserId, state } = await seedGrant(ctx);
    // The last step, after the tokens and the consent row are deleted.
    vi.spyOn(
      SqliteOauthProviderStore.prototype,
      "revokeAuthorizationCodesForGrant",
    ).mockRejectedValueOnce(new Error("the codes could not be reached"));
    await expect(
      oauth.revokeTokensForGrant(clientId, authUserId),
    ).rejects.toThrow("the codes could not be reached");
    expect(await state()).toEqual({ token: true, consent: true });
  });
});
