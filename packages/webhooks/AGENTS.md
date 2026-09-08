# @withmarfa/webhooks

Inbound-webhook signature verification for the providers the platform supports, plus a generic HMAC-SHA256 baseline. Web Crypto only, so the code runs on any modern JS runtime. Public package, published to npm; the server's webhook-receipt route is the in-tree consumer.

## Authoring rules

- **Web Crypto only.** No `node:crypto`, no `Buffer`, no `crypto.createHmac`. Anything new lands through `crypto.subtle`, and the shared helpers in `crypto.ts` are the single path.
- **Constant-time compare.** Signature equality goes through `timingSafeEqual`, never `===` on signature bytes.
- **Raw body in, raw signature in, boolean with a diagnostic out.** A verifier does not parse JSON, fetch secrets or log. Materializing the secret and supplying the raw body is the caller's job.
- **A new provider is a new adapter plus a `VerificationMethod` member**, registered in the `ADAPTERS` table so consumers select by string. Split a provider out even when it shares an existing wire shape, so its body schema is declarable at manifest time.

Tests run each adapter against known-good fixtures plus a sweep of tamper cases (modified body, swapped signature, skewed timestamp where the provider has one). No live network calls.
