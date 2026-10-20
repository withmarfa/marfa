# Pages

This directory is the system Marfa's own server-rendered screens are built
from: typed components rendered on the server with Hono's built-in JSX, one
stylesheet, and a few small browser modules that enhance the server's markup.
There is no client framework and no client-side rendering.

## What is here

| Path                  | What it holds                                                               |
| --------------------- | --------------------------------------------------------------------------- |
| `parts/`              | The components. Each is typed and escapes what it renders.                  |
| `styles/tokens.css`   | Colors (light and dark), spacing, radii, type and the focus ring.           |
| `styles/parts.css`    | The parts' styles. It reads tokens and holds no color of its own.           |
| `client/`             | The browser modules, bundled into one script.                               |
| `lockout.ts`          | Turns the wait a refusal names into the minutes a page says.                |
| `reading.ts`          | Reads a rendered page as a person does, for tests: text, fields, forms.     |
| `access-summary.ts`   | The words an approval page says about a choice, for the server and browser. |
| `account-input.ts`    | What the owner's pages say about a name, email, password and passkey name.  |
| `local-date.ts`       | How a date is written: UTC from the server, the viewer's zone in the page.  |
| `registry.ts`         | The pages of the console, for the page picker and the command search.       |
| `navigation.ts`       | Logic the server and the browser share: stepping, matching, pagination.     |
| `assets.generated.ts` | The built stylesheet and script, with their hashes. Generated, not tracked. |

## The parts

- **Shell:** `PageShell` writes the document: doctype, language, viewport,
  title, and the stylesheet with the response's nonce. Unless the page sets
  `needsScript={false}`, it also loads the script with the nonce and writes a
  one-line `<noscript>` notice. A page that works in full without script (the
  signed-out and problem pages) sets it to false, so it loads no script and
  does not say it needs one. A page that works in full without script but is
  better with it (the approval pages, whose summary lines the script keeps
  true) adds `enhancedByScript`: the script loads and the notice stays out.
- **Layout:** `MomentCard`, `ConsoleColumn`, `PageHeader`, `Section` and
  `Divider`. A `MomentCard` that an app is asking through names it with `app`,
  and shows its first letter beside Marfa's mark.
- **Rows:** `RowGroup`, `Row`, `DisclosureRow`, `RowNote` and `DangerRow`.
  A `Row` or a `DisclosureRow` takes a `badge` such as "New". A `DisclosureRow`
  is a row that opens in place to show more rows, with a line under its title
  that says what they give; the browser opens it, with no script, and `live`
  marks the line for the browser module that rewrites it as they change. A
  `RowNote` is small print at the end of what a row opens to.
- **Controls and fields:** `Button`, `ButtonPair`, `Select`, `Switch`,
  `TextField`, `PasswordField`, `SearchField`, `FormFoot` and `SaveBar`. A
  `Select` and a `Switch` take `data`, which becomes `data-*` attributes for a
  browser module. A `ButtonPair` is two buttons of equal width, the main one
  last.
- **Codes:** `CodeCells` shows a code for a person to compare with the one on
  their device, one cell for each character, as one picture named by the code.
- **Feedback:** `Notice`, `EmptyState` and `Dialog`.
- **Dates:** `LocalDate` writes a date as `<time datetime="..." data-local-date>`
  with the UTC date as its text. `client/local-date.ts` writes the text again
  as the date in the viewer's own time zone, and a page that swaps in server
  markup after load calls `localizeDates` on what it swapped in. A `Row`'s
  `description` takes a `LocalDate` among its markup.
- **Confirming it's you:** `ConfirmDialog` is the dialog a page opens when a
  change is refused for a sign-in older than five minutes. A page puts it once
  at the end of its body. A page with a stylesheet of its own embeds
  `ConfirmDialogHost`, which holds the dialog in a shadow root that loads this
  system's stylesheet, so neither stylesheet reaches the other.
- **Lists:** `ListToolbar`, `Tabs` and `Pager`.
- **Navigation:** `Breadcrumb` (with the page picker) and `CommandSearch`.
  `SearchField` with `shortcutHint` also shows a button that opens the search,
  hidden until the script knows the shortcut for the platform.
  `CommandSearch` writes the pages and loads the settings from the settings
  page's `.json` answer when it first opens, so a page's `settings` in the
  registry reach Home search only.
- **Console page:** `ConsolePage` is the layout every console page uses: the
  document, `Breadcrumb`, `CommandSearch`, `ConsoleColumn` and `ConfirmDialog`.

Import from `parts/index.ts`.

## Layout rules

Keep these in every page you build.

- A console page is one quiet column 720 pixels wide with no sidebar. A moment
  (sign-in, claim, approval, signed out, problem) is one card 384 pixels wide.
- A console page is a `ConsolePage`, which starts with a `Breadcrumb`, except
  Home, which has no trail and shows an empty bar. The page
  under Home carries the picker, which lists every other page grouped as Home
  groups them. One level down, a page that has items lists them in a side
  panel.
- A console page is a breadcrumb, a `PageHeader`, then sections. The page's
  one main action goes at the top right of the header, except on a form,
  whose buttons end it on the right in a `FormFoot`.
- A `Section` has a heading, a line under it, and at most one control on its
  right: a search, a select or a button.
- A row ends in exactly one of: a value and chevron, a control, or buttons.
- Use selects. Use `Tabs` only to split one list into its two or three kinds.
- A list has filters on the left and search on the right (`ListToolbar`), one
  line per row cut short with an ellipsis, and pages of 10 rows by default.
  Past 10 rows the `Pager` also offers "Rows per page" (10, 25 or 50, read with
  `parsePageSize` from the `size` query key beside `page`). Never offer "Show
  all". A list that can only say whether a page follows, such as the audit log
  read by cursor, passes `open` to the `Pager`, which then names no total.
- Red is for what cannot be undone, and for something that has stopped. Amber
  is for something that needs a look. Both appear only as a dot or a value,
  never as a filled box, and only where the page is reporting a state.
- Light and dark follow `prefers-color-scheme`. In dark mode, boxes sit one step
  lighter than the page. There is no theme switch.
- Put no color in any file but `tokens.css`, and no `style` attribute or
  inline event handler in markup. `color-literals.test.ts` enforces the first.
  The page policy enforces the second.
- A POST form carries `novalidate` and is validated on the server as well,
  because the form module's inline messages are an enhancement.

## Cards and the save bar

- **Every row sits in a card.** Its text and controls sit on the card's inner
  edges. Only headings and short footnotes sit outside a card.
- **A destructive or closing action is a `DangerRow`:** one row in a card of
  its own, with a border and no fill. Its title and description are on the left
  inner edge and its button is on the right. Use it for revoking a key,
  disconnecting an app, signing out other browsers and removing a connector or
  a passkey, and never leave such a row loose on the page.
- **Save and Discard appear only when something has changed.** A page that
  edits something that exists ends in a `SaveBar` for its form, last in the
  page. The bar starts hidden. `initSaveBar` in `client/save-bar.ts` shows it
  when a control differs from the value the server wrote, counts each such
  control, and hides it when the form is back as it loaded or has been saved.
  Discard puts the controls back with `form.reset()`. A page whose controls
  count only in some states passes `counts`. A form that makes something new
  ends in its own buttons in a `FormFoot`, and has no bar.

## Add a page

1. Start the `.tsx` file with the two JSX pragma lines that every other one
   starts with (`@jsxRuntime automatic` and `@jsxImportSource hono/jsx`).
   Tests that start a child process from outside this package read no
   `tsconfig.json`, so each file names its runtime itself;
   `jsx-pragma.test.ts` checks it.
1. Write the page as a function that returns `ConsolePage` with the parts, and
   render it with `renderDocument`:

   ```tsx
   export function renderKeysPage(nonce: string, instanceName: string): string {
     return renderDocument(
       <ConsolePage
         title="API keys"
         nonce={nonce}
         instanceName={instanceName}
         trail={[{ label: "API keys" }]}
         pageId="keys"
       >
         <PageHeader title="API keys" />
       </ConsolePage>,
     );
   }
   ```

1. Pass `c.var.cspNonce` from the route. `PageShell` throws without a valid
   nonce.
1. Mount the page under `/auth/owner/`, so the console's gate sends a browser
   that is not signed in to sign in and back (`routes/console-gate.ts`).
1. Register the page so the picker, the search and Home link to it, once, at
   module level where the route is defined, with
   `CONSOLE_PAGES.register("keys", { href, hasItems, settings, value, attention })`
   (`routes/console.ts`). A second registration of the same page throws.
   `value` returns the text at the right end of the page's row on Home and
   `attention` returns the lines Home lists under Needs attention, each a short
   title and a link. Both are optional and Home reads them as it renders, so
   Home never changes when a page is added. Home waits two seconds for each.
   One that is late, throws, or returns a link that is not a path on this
   server or a tone other than `warn` or `danger` is left out, logged, and
   shown as "Couldn't check" the page, so one page never takes Home down.
1. Add a test that renders the page and checks its behavior (status, text,
   links, roles), not its class names.

### Pages that are not built yet

`registry.ts` defines every Home page by name, but a page has no address until
it registers one. The picker and the command search read only registered
pages, so an unbuilt page is not rendered at all, not even as disabled text, and
a group with no registered page is left out. A registered address must be a path
on this server.

### Addresses

Every address a part renders goes through `localHref` in `href.ts`, and a bad
one throws at render, as a bad nonce does. An address is `/`, or `/` followed
by a character that is not `/` or `\`, with no control character anywhere.
The check exists because a URL parser drops tab, carriage return and line feed,
so `/\t/evil.example` would otherwise read as a link to another host. `Button`,
`Tabs` and `Pager` also take a same-page form: an empty string, or a query or
fragment alone.

### Untrusted text

Render it as a child or an attribute value and it is escaped. Do not use
`raw()` or `dangerouslySetInnerHTML`. Icons are the one fixed set in
`icons.tsx`, drawn as JSX.

## Browser modules

Each module in `client/` finds its own markup through a `data-` attribute and
does nothing without it. `access.ts` finds an approval form (`data-access`),
keeps the line under each of its rows (`data-access-group`) true as controls
change, and hides "If everything is off, approving denies the request." while
something is on. It calls the functions in `access-summary.ts`, which the
server calls for the same lines, so the two cannot disagree. `client/confirm.ts` drives the dialog: `sendConfirmed` sends a change, and
when the answer is the refusal for an old sign-in it asks the person to
confirm, posts the proof to `/auth/confirm`, and sends the change once more.
A page's own script reaches it as `window.marfaConfirm.send`. An approval page
posts a plain form, so its form names how long the sign-in has left and which
of its scopes need a recent one (`gateAttributes`), and its approve button
opens the dialog first when the person chose one of those too late.
`client/account.ts` runs the forms in the owner's Profile and Password and
passkeys pages (`data-account-form`): it checks the value with the words in
`account-input.ts`, sends it to the door that makes the change, and then reads
the page's own address again to swap in the region marked `data-live`, so the
browser never draws a row. `client/local-date.ts` is shared: any page that
shows a date writes it with `LocalDate`, and the script does the rest.
`client/save-bar.ts` is shared: any edit page calls `initSaveBar` for its
form. `client/page-state.ts` is shared too: the flash a page keeps across its
own reload, the busy state of a button and the words for a refused request.
`client/general.ts` sends only the controls that changed on General through
`PATCH /config`, and `client/health.ts` runs a housekeeping job from its Run
now button. `client/index.ts` starts them all. They use the DOM only: no `innerHTML`, and styles are set through `element.style` where needed.
The server renders a control that needs a script (the picker button, the
password toggle, the shortcut hint, Sign out, a list's Rows per page) hidden, and the script shows it, so a
browser without the script has no control that does nothing.

`client/tsconfig.json` gives these files the DOM library, which the rest of the
server does not use.

## Assets

`scripts/build-page-assets.ts` bundles `client/` with esbuild into one script,
joins `tokens.css` and `parts.css` into one stylesheet, and writes both into
`assets.generated.ts` with the SHA-1 of each.

- Git does not track `assets.generated.ts`, so two pull requests that change
  the pages never conflict in it. `pnpm install` (the server's `prepare`
  script), `pnpm build`, `pnpm dev`, `generate:openapi`, the tests' global
  setup, and the scripts that boot the server from source
  (`conformance/scripts/marfa-server.ts` and `core/scripts/server-up.sh`)
  each write it from the sources first, and leave a current file alone.
- `pnpm --filter @withmarfa/server assets:build` writes it by hand, and
  `pnpm --filter @withmarfa/server assets:watch` rebuilds when a source
  changes, for use beside `pnpm dev`.
- `assets.test.ts` checks that the file is what the sources build to and that
  a write is whole and happens only when the bytes differ.

The server serves the files at `/auth/static/pages.css` and
`/auth/static/pages.js`, through the same route, with the same strong ETag,
304 and cache rule as the auth assets. A page names each file with `?v=` and
its hash. The files carry the page's nonce on their tags; the policy allows
nothing by origin.
