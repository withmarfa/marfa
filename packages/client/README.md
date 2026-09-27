# @withmarfa/client

The TypeScript client for a Marfa instance, generated from the repository's `openapi.json`. Paths, parameters, bodies and answers are typed from the document: a path the document does not name, or a required parameter left out, does not compile. Ranges and formats the document states only in prose are the server's to refuse.

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

A door that takes raw bytes, such as `POST /blobs`, takes them as a `Blob`, an `ArrayBuffer`, a typed array or a `ReadableStream`, sent as they are, with the `Content-Type` the caller names, else a `Blob`'s own type, else the one the door declares: `await marfa.POST("/blobs", { body: bytes, headers: { "Content-Type": "image/png" } })`.

## The contract

The client carries the contract version it was generated for as `CONTRACT_VERSION`, and every answer the server sends carries its own as the `X-Marfa-Contract` header. The client checks that header on each answer before handing it on: one that names another contract, or a success that names none, is refused with `ContractMismatchError`. An error answer with no header is handed on as it came, since a proxy in front of the server answers without one and its status is still the truth. The credential is sent only under the `baseUrl` the client was made for, and never after a redirect. Both happen inside the client's own `fetch`, so middleware added with `client.use` sees a request without the credential and an answer already checked.

## Pages

Every list and search answers `{ data, next_cursor }`. `pages` walks one to the end, following `next_cursor` until it is `null`. A page can be short, or empty, with a cursor still to follow, so the walk never stops on a short page.

## What it does not do

It sends what the document declares and hands back what the server answered. It does not retry, poll a bulk job, read the event stream, verify a webhook's signature or resolve a conflict: a refusal comes back as the server's envelope, with `Retry-After` on the response where the server sent one.

## Generating

`src/generated/schema.ts` and `src/generated/byte-bodies.ts` come from `scripts/generate-schema.ts`, which runs [openapi-typescript](https://openapi-ts.dev) with a request body of `format: binary` typed as bytes rather than a string, and `src/generated/contract.ts` from `scripts/generate-contract.ts`, all read off `openapi.json` by `pnpm generate` at the repository root. They are committed and none is edited by hand; CI's "Generated clients are fresh" job regenerates them into an emptied `src/generated/` and refuses any difference, including a file there the generator did not write. Requests go through [openapi-fetch](https://openapi-ts.dev/openapi-fetch/).
