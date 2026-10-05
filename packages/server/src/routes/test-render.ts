/**
 * The page renderers, for tests that render a page without a request.
 *
 * Each takes the nonce its response's policy names, which a request supplies
 * and a bare render does not. These give every render a fixed one, so a test
 * that asks what a page says does not have to invent what the page is allowed
 * to load.
 */
import { renderAuthLayout as layout } from "./auth-layout.js";
import { renderAuthErrorPage as authError } from "./auth-error.js";
import { renderConsentScreen as consent } from "./consent.js";
import {
  renderDeviceConsentScreen as deviceConsent,
  renderDeviceDecisionPage as deviceDecision,
  renderDevicePage as device,
} from "./device-pages.js";
import { renderHttpErrorPage as httpError } from "./http-error-page.js";
import { renderSignInPage as signIn } from "./sign-in-page.js";
import { renderSignedInPage as signedIn } from "./signed-in-page.js";
import { renderSignedOutPage as signedOut } from "./signed-out-page.js";
import { renderAuthorizeExpiredPage as expired } from "./authorize-expired-page.js";

/** The nonce every render below is given. */
export const TEST_NONCE = "test-nonce";

type WithoutNonce<T> = Omit<T, "nonce">;

export const renderAuthLayout = (
  params: WithoutNonce<Parameters<typeof layout>[0]>,
): string => layout({ ...params, nonce: TEST_NONCE });

export const renderConsentScreen = (
  params: WithoutNonce<Parameters<typeof consent>[0]>,
): string => consent({ ...params, nonce: TEST_NONCE });

export const renderDevicePage = (
  params: WithoutNonce<Parameters<typeof device>[0]>,
): string => device({ ...params, nonce: TEST_NONCE });

export const renderDeviceConsentScreen = (
  params: WithoutNonce<Parameters<typeof deviceConsent>[0]>,
): string => deviceConsent({ ...params, nonce: TEST_NONCE });

export const renderDeviceDecisionPage = (
  params: WithoutNonce<Parameters<typeof deviceDecision>[0]>,
): string => deviceDecision({ ...params, nonce: TEST_NONCE });

export const renderSignInPage = (
  params: WithoutNonce<Parameters<typeof signIn>[0]>,
): string => signIn({ ...params, nonce: TEST_NONCE });

export const renderSignedInPage = (
  params: WithoutNonce<Parameters<typeof signedIn>[0]>,
): string => signedIn({ ...params, nonce: TEST_NONCE });

export const renderAuthErrorPage = (errorCode: string | null): string =>
  authError(errorCode, TEST_NONCE);

export const renderHttpErrorPage = (status: number): string =>
  httpError(status, TEST_NONCE);

export const renderSignedOutPage = (): string => signedOut(TEST_NONCE);

export const renderAuthorizeExpiredPage = (
  failure?: Parameters<typeof expired>[1],
): string => expired(TEST_NONCE, failure);
