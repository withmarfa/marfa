# Marfa's own pages

The pages the server draws itself (sign in, claiming, recovery, allowing an app or a device, passkeys and password, notices) share one stylesheet, `page.css`, and one script, `page.js`. The templates are in `../templates`.

## Preview

The preview draws every page in every state its view can take, on made-up data, through the real page functions. It is built only for tests and is never part of a release.

To write it, run from `core/`:

```sh
MARFA_WRITE_PAGE_PREVIEW=/tmp/marfa-pages cargo nextest run -p marfa-server preview
```

The folder then holds one HTML file for each state and an `index.html` that shows each state at desktop (1280 px) and phone (390 px) width. Open `index.html` in a browser, or open a state's file for the page at full size.

A file is named after the design board it is compared with, such as `U1-sign-in.html`. A state with no board has a plain name, such as `sign-in-failed.html`. Without the variable the test still renders every state, which checks that each one renders.

### Screenshots

`preview-screenshots.sh` takes a headless Chrome screenshot of every state at both widths, beside the files:

```sh
core/marfa-server/src/http/pages/assets/preview-screenshots.sh /tmp/marfa-pages light
```

The second argument is `light` (the default) or `dark`. Set `CHROME` to use a browser other than the one the script finds.

### Add a state

Open `preview.rs`, in the folder above this one, and add a `State::new(board, slug, title, page)` to `states()`:

- `board` is the design board's number, such as `Some("U8")`, or `None`.
- `slug` is the file's name after the board. Every file name is unique, and the test fails if one repeats.
- `page` is the result of the page function for a view you build on made-up data.

A state that needs a click, such as a dialog open or a detail opened, takes `.after(&[...])` with preview-only scripts: the generator adds them after the page's own script, in the file only. `OPEN_CONFIRM_DIALOG` and `OPEN_DETAILS` are examples. `.without_javascript()` writes the page with its script removed, to check what a reader sees with JavaScript off.

A new view gets a state for each thing it can show: its plain page, each problem it can name, and a long or right-to-left name where one is shown.
