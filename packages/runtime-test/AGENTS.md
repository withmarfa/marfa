# @withmarfa/runtime-test

In-memory mocks of the runtime's dispatch primitives, plus `createTestHarness`, so an Integration can drive its handlers without booting the server.

## What is pinned here rather than in a consuming package

- **`harness.test.ts`** pins the harness primitives themselves: per-connection storage isolation, retry and fail outcomes from handler results, queue drain semantics.
- **`in-memory-{queue,storage}.test.ts`** pin each primitive in isolation.
- **`e2e-flow.test.ts`** composes a runtime-sdk consumer with the harness across two integrations in a chain, webhook to primary handler to simulated reactive event to secondary handler. It is the one test that catches regressions in seam-crossings: the envelope's integration filter, the base64 body decode at the dispatch seam, and cycle-metadata threading. The verify-and-enqueue side is pinned by the server's webhook-receipt suite; this picks up from the queue onwards.

**A new flow that composes the same primary-to-secondary shape is another `it(...)` in that file; anything else is its own `<flow>-flow.test.ts`** with fixtures under `src/fixtures/`. Each flow file's docstring says what the test catches if reverted, so a future reader knows which production fix it guards.

**Handlers live in a module-level registry**, so a test running several integrations in one file calls `_resetHandlers()` between phases. The fixtures directory is deliberately not exported: fixtures are test-only.
