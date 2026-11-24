# Marfa's own pages

The pages the server draws itself (sign in, claiming, recovery, allowing an app or a device, passkeys and password, notices) share one stylesheet, `page.css`, and one script, `page.js`. The templates are in `../templates`.

## Parts

Every page is built from the parts below. A page names its parts and adds none of its own styling. The macros are in `../templates/partials/parts.html`; a template that uses them starts with `{% import "partials/parts.html" as parts %}`, and a macro that wraps content ends with `{% endcall %}`.

| Part | Macro | What it is for |
| --- | --- | --- |
| Head | `parts::head(title, lede)` | The page's one `h1` and at most one line under it. |
| Field | `parts::field(id, label, ...)` | One input with its label inside the box. |
| Joined group | `parts::group(...)` | Fields that answer one question, in one box, with one hint or problem under it. |
| Actions | `parts::actions()` | Buttons at the trailing edge, the main action last. |
| Box of rows | `parts::box_of_rows(symbols)` | A list of rows, each with words and at most one control. `symbols` lines the dividers up with the words of rows that start with an icon. |
| Icon | `parts::icon(name)` | The icon at the start of a row: `items`, `link`, `person` or `sliders`. |
| Pop-up | `parts::pop(id, name, label, ...)` | A choice between levels, as a real `select`. |
| Dialog | `parts::dialog(id, title, ...)` | A window over the page, drawn as a sheet at the bottom on a phone. |

The rows of the allow page are macros of their own in `../templates/partials/rows.html`: `rows::level` is a row with a pop-up of levels, and `rows::power` is a row of the admin powers with Allow or Don't Allow.

To add a part, write its macro in `parts.html` and its rules in `page.css`, and add a state that shows it to `preview.rs`. Name the part for what it is, not for a page that uses it.

## Every page

These hold for every page, so a new page gets them by using the parts.

- **No name for the Marfa.** A page never shows the instance's name, and the tab title is the page's own title.
- **The label sits in the box.** The input comes before its label in the markup, `placeholder=" "` lets the stylesheet tell a filled field from an empty one, and the label lifts when the field is focused, filled or autofilled. Under reduced motion it moves without animation. Every label is a real `label for`.
- **A problem replaces the hint.** A group shows one line under its box: its hint, or the problem, never both. A problem line starts with an icon the stylesheet draws, so it does not rest on color alone, and the field it names carries `aria-invalid="true"`.
- **Focus.** A page puts the cursor in the first empty field, or the first field with a problem, only when the device has a fine pointer, such as a mouse. A phone waits for a tap so the keyboard does not cover the page.
- **Buttons wait while a form sends.** A form's buttons are disabled until the answer arrives, and come back if the browser shows the page again from its cache.
- **A dialog returns focus** to the control that opened it.
- **Sizes are in `rem`.** Controls are 2 rem tall, compact ones 1.75 rem, and every control is 2.75 rem (44 px) on a phone (600 px wide or less). A button's words wrap and its row of actions wraps, so large text never runs off the page. On a phone the column fills the width.
- **A palette for light and dark.** Colors are the properties at the top of `page.css`, with one value for each in the dark block. Check the contrast of a new pair in both.
- **States are styled by what they are.** `:focus`, `:disabled`, `:autofill` and `[aria-invalid="true"]`, not by a class a script adds.
- **Reduced motion and forced colors** are handled in the stylesheet: no animation under `prefers-reduced-motion`, and system colors under `forced-colors`.
- **Nothing depends on JavaScript to be readable.** A page without its script shows the same words and fields; the script only adds the checks and passkey steps.

## The allow page

One page, `consent.html`, asks for an app's access and for a device's, so a change to it changes both.

- **A summary, then the choices.** The box at the top says in one line each what the app gets. **Choose…** is a `details` at the start of the actions, and it opens the choices in place: Items, Profile and the admin level, each a real `select` with a label. It is a `details`, not a button, so it works without the script, and Return never opens it.
- **Allow submits.** Allow is the first button in the markup, so Return in the page submits it, and the stylesheet's `order` draws it last. The tab order therefore reaches Allow before Don't Allow, the reverse of how they are drawn.
- **Rows count only under their choice.** The rows under Each Type and Custom count only while the pop-up above them is set to that choice. A page without its script shows every row with a line saying so, and a page with its script shows the rows only under that choice.
- **A level is a word in title case,** from `words.rs`, which also holds the other words of the page. The command line and `GLOSSARY.md` use the same words for the levels, and `ci/access-words.test.ts` holds the three equal.
- **No caution notice.** An app with a name nobody checked is marked "(unverified)" beside its name, and its name is in `bdi` so a long or right-to-left name wraps and keeps its place.
- **Confirm it's you** is the shared dialog, a sheet at the bottom on a phone. Its password comes first and "Use a passkey" sits under it.

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

A state that needs a click, such as a dialog open or a detail opened, takes `.after(&[...])` with preview-only scripts: the generator adds them after the page's own script, in the file only. `OPEN_CONFIRM_DIALOG` and `OPEN_DETAILS` are examples. `.choose_open()` opens the allow page's Choose… in the file, and `PICK` is a helper for picking a level in a row by its title. `.without_javascript()` writes the page with its script removed, to check what a reader sees with JavaScript off.

A new view gets a state for each thing it can show: its plain page, each problem it can name, and a long or right-to-left name where one is shown.
