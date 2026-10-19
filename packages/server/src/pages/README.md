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
| `registry.ts`         | The pages of the console, for the page picker and the command search.       |
| `navigation.ts`       | Logic the server and the browser share: stepping, matching, pagination.     |
| `assets.generated.ts` | The built stylesheet and script, with their hashes. Generated; do not edit. |

## The parts

- **Shell:** `PageShell` writes the document: doctype, language, viewport,
  title, and the stylesheet with the response's nonce. Unless the page sets
  `needsScript={false}`, it also loads the script with the nonce and writes a
  one-line `<noscript>` notice. A page that works in full without script (the
  signed-out and problem pages) sets it to false, so it loads no script and
  does not say it needs one.
- **Layout:** `MomentCard`, `ConsoleColumn`, `PageHeader` and `Section`.
- **Rows:** `RowGroup`, `Row` and `ClosingAction`.
- **Controls and fields:** `Button`, `Select`, `Switch`, `TextField`,
  `PasswordField`, `SearchField` and `FormFoot`.
- **Feedback:** `Notice`, `EmptyState` and `Dialog`.
- **Lists:** `ListToolbar`, `Tabs` and `Pager`.
- **Navigation:** `Breadcrumb` (with the page picker) and `CommandSearch`.

Import from `parts/index.ts`.

## Layout rules

Keep these in every page you build.

- A console page is one quiet column 720 pixels wide with no sidebar. A moment
  (sign-in, claim, approval, signed out, problem) is one card 384 pixels wide.
- A console page starts with a `Breadcrumb`. The page under Home carries the
  picker, which lists every other page grouped as Home groups them. One level
  down, a page that has items lists them in a side panel.
- A console page is a breadcrumb, a `PageHeader`, then sections. The page's
  one main action goes at the top right of the header, except on a form,
  whose buttons end it on the right in a `FormFoot`.
- A `Section` has a heading, a line under it, and at most one control on its
  right: a search, a select or a button.
- A row ends in exactly one of: a value and chevron, a control, or buttons.
- An action that ends a page by acting on the whole of it (revoke, sign out the
  others) is a `ClosingAction`: no box, under a thin line.
- Use selects. Use `Tabs` only to split one list into its two or three kinds.
- A list has filters on the left and search on the right (`ListToolbar`), one
  line per row cut short with an ellipsis, and pages of 10 rows (`Pager`).
  Never offer "Show all".
- Red is only for what cannot be undone.
- Light and dark follow `prefers-color-scheme`. In dark mode, boxes sit one step
  lighter than the page. There is no theme switch.
- Put no color in any file but `tokens.css`, and no `style` attribute or
  inline event handler in markup. `color-literals.test.ts` enforces the first.
  The page policy enforces the second.
- A POST form carries `novalidate` and is validated on the server as well,
  because the form module's inline messages are an enhancement.

## Add a page

1. Write the page as a function that returns `PageShell` with the parts, and
   render it with `renderDocument`:

   ```tsx
   export function renderKeysPage(nonce: string, instanceName: string): string {
     return renderDocument(
       <PageShell title="API keys" nonce={nonce}>
         <Breadcrumb
           home={{ label: instanceName, href: "/" }}
           trail={[{ label: "API keys" }]}
           registry={PAGE_REGISTRY}
           pageId="keys"
         />
         <CommandSearch registry={PAGE_REGISTRY} home={{ href: "/" }} />
         <ConsoleColumn>
           <PageHeader title="API keys" />
         </ConsoleColumn>
       </PageShell>,
     );
   }
   ```

2. Pass `c.var.cspNonce` from the route. `PageShell` throws without a valid
   nonce.
3. Register the page so the picker and the search link to it:
   `PAGE_REGISTRY.register("keys", { href, hasItems, settings })`. Do this where
   the route is mounted.
4. Add a test that renders the page and checks its behavior (status, text,
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
does nothing without it. `client/index.ts` starts them all. They use the DOM
only: no `innerHTML`, and styles are set through `element.style` where needed.
The server renders a control that needs a script (the picker button, the
password toggle, the shortcut hint) hidden, and the script shows it, so a
browser without the script has no control that does nothing.

`client/tsconfig.json` gives these files the DOM library, which the rest of the
server does not use.

## Assets

`scripts/build-page-assets.ts` bundles `client/` with esbuild into one script,
joins `tokens.css` and `parts.css` into one stylesheet, and writes both into
`assets.generated.ts` with the SHA-1 of each.

- `pnpm build` and `pnpm dev` run it first.
- `pnpm --filter @withmarfa/server assets:watch` rebuilds when a source
  changes, for use beside `pnpm dev`.
- `assets.test.ts` fails when the committed file differs from what the sources
  build to, so run `pnpm --filter @withmarfa/server assets:build` and commit the
  result after changing a style or a module.

The server serves the files at `/auth/static/pages.css` and
`/auth/static/pages.js`, through the same route, with the same strong ETag,
304 and cache rule as the auth assets. A page names each file with `?v=` and
its hash. The files carry the page's nonce on their tags; the policy allows
nothing by origin.
