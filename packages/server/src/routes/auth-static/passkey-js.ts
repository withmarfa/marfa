/**
 * Browser-side WebAuthn ceremony for passkey enroll + sign-in.
 *
 * Wave C PR6 / T-034. Served from `GET /auth/passkey/passkey.js` (see
 * `auth-static.ts` mounts). Imported as a TypeScript template literal
 * (same pattern as `auth-css.ts`) so tsup bundles it into `dist/`
 * without a separate static-asset copy step.
 *
 * The script exposes a single global `MarfaPasskey` with `enroll()` +
 * `signIn()` async functions. The pages wire onClick handlers that
 * call them and toggle status banners on success / failure.
 *
 * Implementation note. Better-auth's passkey plugin builds its options
 * via `@simplewebauthn/server`'s `generateRegistrationOptions` — the
 * response is `PublicKeyCredentialCreationOptionsJSON` (challenge as
 * base64url, etc). The browser's `navigator.credentials.create()`
 * needs ArrayBuffers, so we decode JSON → ArrayBuffer here, run the
 * ceremony, then encode `PublicKeyCredential` → `RegistrationResponseJSON`
 * to POST back. The server-side `verifyRegistrationResponse` expects
 * exactly that JSON shape — we match SimpleWebAuthn's contract.
 */

export const PASSKEY_JS = `(function () {
  'use strict';

  function bufferToBase64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  function base64urlToBuffer(s) {
    var pad = (4 - (s.length % 4)) % 4;
    var b64 = (s + '===='.slice(0, pad)).replace(/-/g, '+').replace(/_/g, '/');
    var binary = atob(b64);
    var buf = new ArrayBuffer(binary.length);
    var view = new Uint8Array(buf);
    for (var i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
    return buf;
  }

  function decodeCreationOptions(json) {
    var out = Object.assign({}, json, {
      challenge: base64urlToBuffer(json.challenge),
    });
    if (json.user && typeof json.user.id === 'string') {
      out.user = Object.assign({}, json.user, { id: base64urlToBuffer(json.user.id) });
    }
    if (Array.isArray(json.excludeCredentials)) {
      out.excludeCredentials = json.excludeCredentials.map(function (c) {
        return Object.assign({}, c, { id: base64urlToBuffer(c.id) });
      });
    }
    return out;
  }

  function decodeRequestOptions(json) {
    var out = Object.assign({}, json, {
      challenge: base64urlToBuffer(json.challenge),
    });
    if (Array.isArray(json.allowCredentials)) {
      out.allowCredentials = json.allowCredentials.map(function (c) {
        return Object.assign({}, c, { id: base64urlToBuffer(c.id) });
      });
    }
    return out;
  }

  function encodeRegistration(credential) {
    var resp = credential.response;
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults
        ? credential.getClientExtensionResults()
        : {},
      response: {
        clientDataJSON: bufferToBase64url(resp.clientDataJSON),
        attestationObject: bufferToBase64url(resp.attestationObject),
        transports: typeof resp.getTransports === 'function' ? resp.getTransports() : undefined,
      },
    };
  }

  function encodeAssertion(credential) {
    var resp = credential.response;
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults
        ? credential.getClientExtensionResults()
        : {},
      response: {
        clientDataJSON: bufferToBase64url(resp.clientDataJSON),
        authenticatorData: bufferToBase64url(resp.authenticatorData),
        signature: bufferToBase64url(resp.signature),
        userHandle: resp.userHandle ? bufferToBase64url(resp.userHandle) : null,
      },
    };
  }

  /** Capability probe — exposed so pages can hide the passkey button on
   *  unsupported browsers / non-secure contexts. */
  function isSupported() {
    return (
      typeof window !== 'undefined' &&
      window.isSecureContext &&
      window.PublicKeyCredential &&
      typeof navigator !== 'undefined' &&
      navigator.credentials &&
      typeof navigator.credentials.create === 'function' &&
      typeof navigator.credentials.get === 'function'
    );
  }

  async function enroll(opts) {
    var name = (opts && opts.name) || undefined;
    var optsUrl = '/auth/passkey/generate-register-options' + (name ? '?name=' + encodeURIComponent(name) : '');
    var optsRes = await fetch(optsUrl, { credentials: 'include' });
    if (!optsRes.ok) {
      var msg = 'Could not start passkey enrolment.';
      try { var body = await optsRes.json(); if (body && body.message) msg = body.message; } catch (e) {}
      throw new Error(msg);
    }
    var optionsJson = await optsRes.json();
    var credential = await navigator.credentials.create({ publicKey: decodeCreationOptions(optionsJson) });
    if (!credential) throw new Error('Passkey enrolment was cancelled.');
    var verifyRes = await fetch('/auth/passkey/verify-registration', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: encodeRegistration(credential), name: name }),
    });
    if (!verifyRes.ok) {
      var verr = 'Passkey enrolment failed.';
      try { var ebody = await verifyRes.json(); if (ebody && ebody.message) verr = ebody.message; } catch (e) {}
      throw new Error(verr);
    }
    return await verifyRes.json();
  }

  async function signIn() {
    var optsRes = await fetch('/auth/passkey/generate-authenticate-options', { credentials: 'include' });
    if (!optsRes.ok) {
      var msg = 'Could not start passkey sign-in.';
      try { var body = await optsRes.json(); if (body && body.message) msg = body.message; } catch (e) {}
      throw new Error(msg);
    }
    var optionsJson = await optsRes.json();
    var credential = await navigator.credentials.get({ publicKey: decodeRequestOptions(optionsJson) });
    if (!credential) throw new Error('Passkey sign-in was cancelled.');
    var verifyRes = await fetch('/auth/passkey/verify-authentication', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: encodeAssertion(credential) }),
    });
    if (!verifyRes.ok) {
      var verr = 'Passkey sign-in failed.';
      try { var ebody = await verifyRes.json(); if (ebody && ebody.message) verr = ebody.message; } catch (e) {}
      throw new Error(verr);
    }
    return await verifyRes.json();
  }

  window.MarfaPasskey = { enroll: enroll, signIn: signIn, isSupported: isSupported };
})();
`;
