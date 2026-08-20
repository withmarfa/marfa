# @withmarfa/webhooks

Inbound-webhook signature verification. Web Crypto only — no `node:crypto`, no Node APIs — so the code runs on any modern JS runtime; `@withmarfa/server`'s webhook-receipt route is the in-tree consumer. Public package, published to npm.

## Layout

- `src/index.ts` — public exports: the six verifier functions, the `ADAPTERS` dispatch table, the `Verifier` / `VerifyResult` / `VerificationMethod` types.
- `src/types.ts` — `VerificationMethod` enum (`hmac-sha256`, `slack`, `stripe`, `github`, `google-channel`, `cloudflare-email`) and the shared result shape.
- `src/hmac-sha256.ts` — generic HMAC-SHA256 verifier (raw body + secret + signature header). The "no provider-specific quirks" baseline.
- `src/slack.ts` — Slack v0 verifier (`X-Slack-Signature` over `v0:<timestamp>:<body>`, with timestamp-skew check).
- `src/stripe.ts` — Stripe verifier (`Stripe-Signature` over `<timestamp>.<body>`, with timestamp-skew check).
- `src/github.ts` — GitHub webhook verifier (`X-Hub-Signature-256` over raw body).
- `src/google-channel.ts` — Google push-notification channel verifier (`X-Goog-Channel-Token` against the per-channel token).
- `src/cloudflare-email.ts` — Cloudflare Email Worker verifier. Shares the `hmac-sha256` wire shape; split out so the body schema is declarable at manifest time.
- `src/dispatch.ts` — `ADAPTERS` map; consumers pick a verifier by `VerificationMethod` string.
- `src/crypto.ts` — Web-Crypto helpers (HMAC import / sign / constant-time compare). Single source for the cross-runtime crypto path.

## Authoring rules

- **Web Crypto only.** No `node:crypto`, no `Buffer`, no `crypto.createHmac`. Anything new lands through `crypto.subtle`.
- **Constant-time compare.** Signature equality goes through `timingSafeEqual` in `crypto.ts` — never `===` on signature bytes.
- **Raw-body in, raw signature in, boolean (with diagnostic) out.** Verifiers don't parse JSON, don't fetch secrets, don't log. The caller is responsible for materializing the secret and supplying the raw body.

## Build

`tsup` produces `dist/index.js` (ESM) and `dist/index.d.ts`. No bundled deps — Web Crypto is ambient on both target runtimes.

## Testing

`pnpm test` runs `verify.test.ts` against the adapters with known-good fixtures and a sweep of tamper cases (modified body, swapped signature, future / past timestamp where applicable), plus `google-channel.test.ts` for the header-echo adapter. No live network calls.
