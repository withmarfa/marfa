# @withmarfa/client

The TypeScript client for a Marfa instance, generated from the repository's `openapi.json`. Every path, parameter, body and answer is typed from the document, so a request the server would refuse on shape does not compile.

```ts
import { createClient, pages } from "@withmarfa/client";

const marfa = createClient({
  baseUrl: "https://marfa.example.com",
  credential: process.env.MARFA_API_KEY ?? "",
});

const { data: detail, error } = await marfa.GET("/items/{id}", {
  params: { path: { id } },
});

const everyItem = pages(async (cursor) => {
  const { data } = await marfa.GET("/items", {
    params: { query: { cursor } },
  });
  if (!data) throw new Error("the listing was refused");
  return data;
});
for await (const item of everyItem) {
  // every row, page by page
}
```

## The contract

The client carries the contract version it was generated for as `CONTRACT_VERSION`. Before its first request it reads the instance's root once, without the credential, and if the root's `contract` differs it refuses with `ContractMismatchError` and sends nothing further. A failed check is not remembered as a pass: the next request asks again.

## Pages

Every list and search answers `{ data, next_cursor }`. `pages` walks one to the end, following `next_cursor` until it is `null`. A page can be short, or empty, with a cursor still to follow, so the walk never stops on a short page.

## Generating

`src/schema.ts` comes from [openapi-typescript](https://openapi-ts.dev) and `src/contract.ts` from `scripts/generate-contract.ts`, both read off `openapi.json` by `pnpm generate` at the repository root. Both are committed and neither is edited by hand; CI's "Generated clients are fresh" job regenerates them and refuses a difference. Requests go through [openapi-fetch](https://openapi-ts.dev/openapi-fetch/).
