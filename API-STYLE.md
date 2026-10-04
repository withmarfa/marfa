# API style guide

How Marfa's API description is written: every summary, description and example in `openapi.json`. The server generates that document from its route definitions, so this guide governs the text in those definitions.

The wording follows the [Google developer documentation style guide](https://developers.google.com/style), including its guidance on [API reference text](https://developers.google.com/style/api-reference-comments). Names and shapes follow `GLOSSARY.md`, which follows Stripe's API conventions. Where this guide is silent, follow Google.

**(checked)** marks a rule that `packages/server/src/openapi-style.test.ts` checks. Rules the document is still being brought up to are held at a ceiling there, which only goes down.

## Who reads it

Two readers use every sentence:

- A person reading the API reference, one operation at a time.
- An agent or a code generator reading the document, often one operation, parameter or field at a time.

So each operation, parameter, field and response says what it needs to on its own. A rule that applies everywhere is stated once, in the general sections, and never repeated in an operation.

## Voice

- **"You" is the credential that sends the request**: an API key, or the token of an app someone signed in to. **Marfa** is the actor: "Marfa creates an ID", not "the server stamps an id".
- Present tense and active voice. Short sentences, one idea each. Every word earns its place: the reader should get what they need in one pass.
- No em dashes. Use a colon, a comma, parentheses or a new sentence. **(checked)**
- Use the words in `GLOSSARY.md`, and none of its banned words. Write "ID" in prose and `id` only for the field.
- Say what you can do and what you get back. Don't describe how the server is built: no tables, handlers, middleware, history, issue numbers or reasons a design was chosen. Those belong in the contract or in code comments.
- Use code formatting only for text you would type: field and parameter names, values, error codes, headers, type identifiers, paths.
- Don't link out of the document. **(checked)**
- American English.

## Operations

### Summary

- An imperative verb and its object, in sentence case, with no final period: "Create an item", "Get a blob URL". About four words: the summary is a label, and anything more goes in the description. **(checked: at most 32 characters)**
- Use one verb for one meaning:

  | Verb    | Use it for                                                  |
  | ------- | ----------------------------------------------------------- |
  | Get     | One object, by ID.                                          |
  | List    | A page of objects.                                          |
  | Create  | A new object.                                               |
  | Update  | A partial change (`PATCH`).                                 |
  | Replace | A whole object (`PUT`).                                     |
  | Delete  | Removal. Say what happens to the object in the description. |

  When none fits, use the plain verb for the act, such as Restore, Upload, Search, Revoke, Trash or Purge.

### Description

- **The first sentence starts with the summary's verb in the third person** ("Creates"), or "Returns" for Get and List, and says what the operation does and what it returns. Where that verb would mislead, use the verb for what happens: "Moves the item to the trash".
- **Often that sentence is enough.** Add at most two more, only for what you need to call it correctly: a default you wouldn't expect, an effect beyond the obvious, or a common mistake.
- **(checked: at most 250 characters)** If you need more, the detail belongs on a field, a parameter or a response, in a general section, or in a guide in the docs.
- Don't repeat the parameters, the response codes or a rule that applies everywhere.
- Name another operation only when you need it next, by its method and path: `GET /items/{id}/versions`.

## Parameters

- **Describe every parameter. (checked)**
- An ID in the path: "The ID of the item."
- A filter: "Only return items that …".
- Anything else: what it is, then what it changes.
- **Put fixed facts in the schema, not the text**: type, range, default and allowed values go in `minimum`, `maximum`, `default` and `enum`. The text gives a default only when it depends on something, such as "Defaults to your `default_tier`".
- A comma-separated list says so and names its values.
- **(checked: at most 250 characters)**
- **Take `limit` and `cursor` from `pageLimit` and `pageCursor` in `packages/server/src/page-limits.ts`.** `Idempotency-Key` and `X-Marfa-Read-View` come from `openapi-finalize.ts`. So each has one text everywhere. **(checked: one text per parameter name)** Share a parameter only where it means the same thing; where it means something else on one operation, define it there with its own text.

## Objects and fields

- **Every named object has a description**: one sentence that says what it is. "An item is one record in Marfa." **(checked)**
- **Every field has a description. (checked)** It starts with what the field holds, then adds when it is present or how to use it. A fixed default goes in the schema, as for parameters.
  - The object's own ID: "Unique identifier for the item."
  - Another object's ID: "The ID of the item the edge points to."
  - A time: "When the item was created, in UTC."
  - A boolean: "`true` if …", and, if it can be absent, what that means.
  - An optional field: when it is present.
- **(checked: at most 250 characters)**
- An enum's own description says what each value means, one clause each. For a list of values, that description goes on `items`.
- A schema used in several places has text that is true in all of them. A list that never pages says so on its own page schema: "Always `null`: Marfa returns every webhook in one page."
- In a request body, the field says what happens when you leave it out.

## Responses

- **A success response says what it returns**: "Returns the new item." When one status covers several cases, list them, one line each.
- **An error response lists each code it can return**, one line each: the code, then its cause in plain words. A single code takes a single line. A code with many causes names the common ones: "For example, …".

  ```text
  - `id_reused`: `id` belongs to a different item. `details.differs` says what differs.
  ```

- **The shared responses, `401`, `413`, `429` and `503`, take their text from one definition in `openapi-finalize.ts`**, which adds them to each operation that returns them. **(checked: one text per shared code)** Where a status means something else on one operation, the operation declares its own.
- **(checked: at most 400 characters)**

## Streams and requests Marfa sends

- **A stream** (`text/event-stream`) has a named schema for each frame and a `oneOf` over them. Its success response lists each frame and when it comes, and its example shows the raw stream.
- **A request Marfa sends to you**, such as a webhook delivery, is described in the document's top-level `webhooks`, with its headers, its body and the answers Marfa expects back.

## Examples

- Every success response carries an example of a realistic object.
- A field whose format is not obvious from its type carries an example: IDs, type identifiers, times, cursors.
- Set an example with `.openapi({ example })` on a field, `.openapi("Name", { example })` on a named schema, or `example` beside `schema` in a response's content.
- Invent plausible values. Never use a real person, account or machine. IDs are UUIDv7. Times are UTC with milliseconds: `2026-10-03T09:30:00.000Z`.

## Groups

Each operation has one tag, which is its group in the reference. The groups and their order are `PUBLIC_TAGS` in `packages/server/src/openapi-finalize.ts`, each with a one-sentence description. Add an operation to the group of the object it acts on; add a group only for a new kind of object.

## General sections

The document's `info.description` holds the rules that apply everywhere, each under its own heading: Authentication, Permissions, Pagination, Query parameters, Errors, Idempotency, Time, and the headers on every response. An area whose behavior spans its operations, such as the event stream, gets a section of its own. An operation relies on these sections and doesn't repeat them.

## Where the text lives

- An operation's summary, description and responses: its `createRoute` definition in `packages/server/src/routes/`. The operations served as plain Hono handlers, such as `GET /` and `GET /events`, are written out in `EXTRA_PATHS` in `packages/server/src/openapi-finalize.ts`.
- A field's or parameter's description: `.describe()` on its schema. A code comment never reaches the document.
- The general sections, the shared responses and the shared header parameters: `packages/server/src/openapi-finalize.ts`. `limit` and `cursor`: `packages/server/src/page-limits.ts`.
- After any change, run `pnpm generate` and commit everything it writes in the same pull request: `openapi.json`, the TypeScript client generated from it and the core's contract version.

## Before you open a pull request

1. The summary uses a verb from the table.
2. The description starts with a verb in the third person, is at most three sentences, and has no word it doesn't need.
3. Every parameter, field and response you added or changed is described.
4. Every fact matches the contract in `conformance/spec/`. Where the server and the contract disagree, fix the one that is wrong; never describe around it.
5. `pnpm generate` has run, and `pnpm --filter @withmarfa/server test` passes.
