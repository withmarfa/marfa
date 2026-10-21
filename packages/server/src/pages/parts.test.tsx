/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { raw } from "hono/html";
import { Breadcrumb } from "./parts/breadcrumb.js";
import { CommandSearch } from "./parts/command-search.js";
import { CodeCells } from "./parts/code-cells.js";
import { Button, ButtonPair, Select, Switch } from "./parts/controls.js";
import { Dialog } from "./parts/dialog.js";
import { EmptyState, Notice } from "./parts/feedback.js";
import {
  FormFoot,
  PasswordField,
  RowInput,
  SearchField,
  TextField,
} from "./parts/fields.js";
import {
  ConsoleColumn,
  MomentCard,
  PageHeader,
  Section,
} from "./parts/layout.js";
import { ListToolbar, Pager, Tabs } from "./parts/list.js";
import {
  DangerRow,
  DisclosureRow,
  Row,
  RowGroup,
  RowNote,
} from "./parts/rows.js";
import { SaveBar } from "./parts/save-bar.js";
import { pageButtons, pageRegions, visibleText } from "./reading.js";
import { PageShell } from "./parts/shell.js";
import { pageAssetUrl } from "./assets.js";
import { paginate } from "./navigation.js";
import { renderDocument } from "./render.js";
import { createPageRegistry, HOME_GROUPS } from "./registry.js";
import {
  FixturePage,
  HOSTILE,
  LONG_UNBROKEN,
  fixtureRegistry,
  renderFixturePage,
} from "./test-fixture.js";

const html = (node: { toString(): string | Promise<string> }): string => {
  const out = node.toString();
  if (typeof out !== "string") throw new Error("async render");
  return out;
};

/** The attributes of the first start tag matching `tag` in `markup`. */
function attrs(markup: string, tag: RegExp): Record<string, string> {
  const start = tag.exec(markup);
  if (!start) throw new Error(`no ${String(tag)} in ${markup}`);
  const open = /^<[a-z0-9]+((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/i.exec(
    markup.slice(start.index),
  );
  const out: Record<string, string> = {};
  for (const [, name, value] of (open?.[1] ?? "").matchAll(
    /([^\s=>]+)(?:="([^"]*)")?/g,
  ))
    out[name ?? ""] = value ?? "";
  return out;
}

describe("PageShell", () => {
  const page = (nonce: string) =>
    renderDocument(
      <PageShell title="A title" nonce={nonce}>
        <p>body</p>
      </PageShell>,
    );

  it("writes the document around the page", () => {
    const out = page("abc123");
    expect(out.startsWith('<!DOCTYPE html><html lang="en">')).toBe(true);
    expect(out).toContain('<meta charset="utf-8"/>');
    expect(out).toContain("width=device-width, initial-scale=1");
    expect(out).toContain("<title>A title</title>");
    expect(out).toContain("<p>body</p>");
  });

  it("carries the nonce on the stylesheet and the script, and nowhere without it", () => {
    const out = page("abc123");
    expect(attrs(out, /<link /)).toMatchObject({
      rel: "stylesheet",
      href: pageAssetUrl("pages.css"),
      nonce: "abc123",
    });
    expect(attrs(out, /<script /)).toMatchObject({
      src: pageAssetUrl("pages.js"),
      nonce: "abc123",
    });
    expect(out).not.toContain("<style");
    expect(out).not.toMatch(/\sstyle="/);
    expect(out).not.toMatch(/\son[a-z]+="/);
  });

  it("says in a noscript line that the page needs JavaScript", () => {
    expect(page("abc123")).toMatch(
      /<noscript><p class="noscript">This page needs JavaScript\./,
    );
  });

  it("escapes the title", () => {
    const out = renderDocument(<PageShell title={HOSTILE} nonce="abc123" />);
    expect(out).toContain("<title>&lt;script&gt;");
    expect(out).not.toContain("<script>window");
  });

  it.each(["", " ", "has space", 'a"b', "a<b", "a'b"])(
    "refuses the nonce %j rather than emit a policy-proof page",
    (nonce) => {
      expect(() => page(nonce)).toThrow(/nonce/);
    },
  );

  it("refuses a nonce that is not a string", () => {
    expect(() => page(undefined as unknown as string)).toThrow(/nonce/);
  });

  it("takes the nonce the policy middleware generates", () => {
    expect(() => page("Zm9vYmFyMTIzNDU2Nzg5MA==")).not.toThrow();
  });
});

describe("escaping", () => {
  it("shows untrusted text in every part as text", () => {
    const out = renderFixturePage({ nonce: "abc123" });
    // Witness: the same string, marked trusted, does put a script in a page,
    // so the absence below is the escaping's doing.
    expect(html(<div>{raw(HOSTILE)}</div>)).toContain(
      "<script>window.__injected = 1</script>",
    );
    expect(out).not.toContain("<script>window.__injected");
    expect(out).not.toContain("<b>bold</b>");
    expect(out).toContain("&lt;script&gt;window.__injected = 1&lt;/script&gt;");
    expect(out).toContain("&quot;quoted&quot;");
  });

  it("keeps a quote in an attribute value inside the attribute", () => {
    const out = html(
      <TextField
        id="x"
        name="x"
        label="X"
        value={'"><script>alert(1)</script>'}
      />,
    );
    expect(attrs(out, /<input /).value).toBe(
      "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(out).not.toContain("<script>");
  });

  it("carries a long unbroken string through unchanged", () => {
    expect(html(<PageHeader title={LONG_UNBROKEN} />)).toContain(LONG_UNBROKEN);
  });
});

describe("layout", () => {
  it("makes a moment card with one heading, the Marfa mark and a status lede", () => {
    const out = html(
      <MomentCard
        title="Signed out"
        lede="See you"
        ledeRole="status"
        foot="Error 404"
      >
        <Button kind="primary" href="/">
          Home
        </Button>
      </MomentCard>,
    );
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain('<div class="marks" aria-hidden="true">');
    expect(out).toContain('<p class="lede" role="status">See you</p>');
    expect(out).toContain('<p class="foot">Error 404</p>');
    expect(attrs(out, /<main /).id).toBe("main");
  });

  it("names the asking app beside Marfa's mark by its first letter, and only when given one", () => {
    const withApp = html(<MomentCard title="Allow" app="harbor" />);
    expect(withApp).toContain('<span class="tile">H</span>');
    expect(withApp.indexOf('class="tile"')).toBeLessThan(
      withApp.indexOf('class="tile marfa"'),
    );
    expect(html(<MomentCard title="Allow" />)).not.toContain('class="tile"');
    // An app named in markup is text, and a name with nothing to show is a question mark.
    expect(html(<MomentCard title="Allow" app="<b>" />)).toContain(
      '<span class="tile">&lt;</span>',
    );
    expect(html(<MomentCard title="Allow" app=" " />)).toContain(
      '<span class="tile">?</span>',
    );
  });

  it("leaves out the lede and foot it was not given", () => {
    const out = html(<MomentCard title="Signed out" />);
    expect(out).not.toContain('class="lede"');
    expect(out).not.toContain('class="foot"');
  });

  it("puts the console in one main region with the header's one action", () => {
    const out = html(
      <ConsoleColumn>
        <PageHeader
          title="API keys"
          lede="Keys"
          action={<Button kind="primary">Create</Button>}
        />
      </ConsoleColumn>,
    );
    expect(attrs(out, /<main /)).toMatchObject({ class: "col", id: "main" });
    expect(out).toContain('<h1 class="title">API keys</h1>');
    expect(out).toContain('<div class="actions">');
  });

  it("labels a section by its heading, and one with no title is not labeled", () => {
    const titled = html(
      <Section
        id="keys"
        title="Keys"
        description="All of them"
        control={<Button>Add</Button>}
      >
        x
      </Section>,
    );
    expect(attrs(titled, /<section /)["aria-labelledby"]).toBe("keys-heading");
    expect(titled).toContain('<h2 class="sech" id="keys-heading">Keys</h2>');
    expect(titled).toContain('<p class="secd">All of them</p>');
    const bare = html(<Section>x</Section>);
    expect(bare).not.toContain("aria-labelledby");
    expect(bare).not.toContain("<h2");
  });
});

describe("rows", () => {
  it("makes a link row that ends in its value and a chevron", () => {
    const out = html(
      <Row
        title="API keys"
        description="Scripts"
        value="3 keys"
        href="/keys"
      />,
    );
    expect(attrs(out, /<a /)).toMatchObject({
      class: "row has-d",
      href: "/keys",
    });
    expect(out).toMatch(/<span class="val">3 keys<\/span><span class="chev">/);
  });

  it("makes a row that opens a dialog a button, not a link", () => {
    const out = html(<Row title="Revoke" opens="confirm" />);
    expect(attrs(out, /<button /)).toMatchObject({
      type: "button",
      "data-dialog-open": "confirm",
    });
    expect(out).not.toContain("<a ");
  });

  it("labels a control row's control by its title", () => {
    const out = html(
      <Row
        title="Trash"
        for="trash"
        control={
          <Select id="trash" options={[{ value: "7", label: "7 days" }]} />
        }
      />,
    );
    expect(out).toContain('<label class="grow" for="trash">');
    expect(out).not.toContain("<a ");
  });

  it("lets a value take the width it needs, and tones a description amber or red", () => {
    const out = html(
      <Row title="Source" value="my-script" valueAuto valueTone="warn" />,
    );
    expect(out).toContain('class="val auto warn"');
    expect(html(<Row title="Source" value="x" />)).toContain('class="val"');
    expect(
      html(<Row title="K" description="Check" descriptionTone="warn" />),
    ).toContain("warn");
    expect(html(<Row title="K" description="Check" />)).not.toContain("warn");
  });

  it("puts a row's buttons at its end", () => {
    const out = html(<Row title="Key" buttons={<Button>Edit</Button>} />);
    expect(out).toMatch(/<span class="ends"><button /);
  });

  it("gives a long description as the tooltip, and a short one none", () => {
    const long = "x".repeat(80);
    expect(html(<Row title="T" description={long} />)).toContain(
      `title="${long}"`,
    );
    expect(html(<Row title="T" description="short" />)).not.toContain("title=");
  });

  it("refuses at compile time a row with two kinds of end", () => {
    // @ts-expect-error a row ends in a link or a control, not both
    const mixed = <Row title="T" href="/x" control={<Switch id="s" />} />;
    expect(mixed).toBeDefined();
  });

  it("keeps a list to one line per row", () => {
    expect(html(<RowGroup oneLine>x</RowGroup>)).toContain(
      'class="group oneline"',
    );
    expect(html(<RowGroup>x</RowGroup>)).toContain('class="group"');
  });
});

describe("a destructive action", () => {
  const revoke = (
    <DangerRow
      title="Revoke this key"
      description="Scripts using it stop working at once. Can't be undone."
      action={
        <Button kind="danger-quiet" opens="revoke-dialog">
          Revoke
        </Button>
      }
    />
  );

  it("is one row in a card of its own, with its words and its button", () => {
    const out = html(revoke);
    expect(visibleText(out)).toBe(
      "Revoke this key Scripts using it stop working at once. Can't be undone. Revoke",
    );
    expect(pageButtons(out)).toEqual([
      expect.objectContaining({ text: "Revoke", type: "button" }),
    ]);
    // The card is the same box every row sits in, drawn with a border and no fill.
    expect(out.startsWith('<div class="group quiet">')).toBe(true);
    expect(out.match(/class="row/g)).toHaveLength(1);
    expect(out).toMatch(/<span class="ends"><button /);
  });

  it("puts the button after the words, where a keyboard reaches it last", () => {
    const out = html(revoke);
    expect(out.indexOf("Revoke this key")).toBeLessThan(out.indexOf("<button"));
  });

  it("escapes what it is given", () => {
    const out = html(
      <DangerRow title={HOSTILE} description={HOSTILE} action={<span />} />,
    );
    expect(out).not.toContain("<script>window");
  });
});

describe("the save bar", () => {
  const bar = html(<SaveBar form="key-form" />);

  it("starts hidden, so a page with nothing changed shows no Save or Discard", () => {
    const group = pageRegions(bar).find((region) => region.role === "group");
    expect(group).toMatchObject({ label: "Unsaved changes", hidden: true });
  });

  it("offers Discard, then Save, which sends the form it belongs to", () => {
    expect(pageButtons(bar)).toEqual([
      expect.objectContaining({
        text: "Discard",
        type: "button",
        form: undefined,
      }),
      expect.objectContaining({
        text: "Save",
        type: "submit",
        form: "key-form",
      }),
    ]);
  });

  it("keeps a polite status line outside the hidden bar, so a reader hears it appear", () => {
    const status = pageRegions(bar).find((region) => region.role === "status");
    expect(status).toMatchObject({ live: "polite", hidden: false });
    expect(bar.indexOf('role="status"')).toBeLessThan(
      bar.indexOf('role="group"'),
    );
  });

  it("says nothing of a count until the script knows one", () => {
    expect(visibleText(bar)).toBe("Discard Save");
  });

  it("names the form it saves by id, and refuses an empty one", () => {
    expect(() => html(<SaveBar form="" />)).toThrow();
  });
});

describe("a row that opens in place", () => {
  it("is a native disclosure a keyboard can open, closed unless told otherwise", () => {
    const closed = html(
      <DisclosureRow title="Already allowed" description="It keeps this.">
        <Row title="Notes" value="Read only" />
      </DisclosureRow>,
    );
    expect(closed).toContain('<details class="disclosure-row">');
    expect(closed).toContain('<summary class="row has-d">');
    expect(closed).toContain('<div class="rt">Already allowed</div>');
    expect(closed).toContain('<div class="rd">It keeps this.</div>');
    expect(closed).toContain('<div class="sub">');
    expect(closed).not.toMatch(/<details[^>]* open/);
    expect(
      html(
        <DisclosureRow title="x" open>
          y
        </DisclosureRow>,
      ),
    ).toMatch(/<details[^>]* open/);
  });

  it("marks the line under its title for the script only when the script keeps it true, and passes data to it", () => {
    const live = html(
      <DisclosureRow
        title="Your data"
        description="Read notes"
        live
        data={{ "access-group": "data" }}
      />,
    );
    expect(live).toContain(
      '<details class="disclosure-row" data-access-group="data">',
    );
    expect(live).toContain('<div class="rd" data-summary="">Read notes</div>');
    expect(
      html(
        <DisclosureRow title="Already allowed" description="It keeps this." />,
      ),
    ).not.toContain("data-summary");
  });

  it("ends in small print that sits inside what the row opens to", () => {
    expect(
      html(
        <DisclosureRow title="x">
          <RowNote>Approving never lowers this.</RowNote>
        </DisclosureRow>,
      ),
    ).toContain(
      '<div class="sub"><p class="sub-note">Approving never lowers this.</p></div>',
    );
  });

  it("shows a badge after the title of a row or a disclosure", () => {
    expect(html(<Row title="Notes" badge="New" />)).toContain(
      '<div class="rt">Notes<span class="badge new">New</span></div>',
    );
    expect(html(<DisclosureRow title="More" badge="New" />)).toContain(
      '<span class="badge new">New</span>',
    );
    expect(html(<Row title="Notes" />)).not.toContain("badge");
  });
});

describe("controls", () => {
  it("makes a link that looks like a button, and a button that is not a submit by default", () => {
    expect(
      html(
        <Button kind="primary" href="/x">
          Go
        </Button>,
      ),
    ).toBe('<a class="btn primary" href="/x">Go</a>');
    expect(attrs(html(<Button>Go</Button>), /<button /).type).toBe("button");
    expect(
      attrs(html(<Button type="submit">Go</Button>), /<button /).type,
    ).toBe("submit");
  });

  it("names an icon-only button", () => {
    const out = html(
      <Button kind="icon-only" label="Previous page">
        x
      </Button>,
    );
    expect(attrs(out, /<button /)).toMatchObject({
      "aria-label": "Previous page",
      title: "Previous page",
    });
  });

  it("keeps a button that only looks unavailable in the tab order", () => {
    const soft = attrs(html(<Button ariaDisabled>Create</Button>), /<button /);
    expect(soft["aria-disabled"]).toBe("true");
    expect("disabled" in soft).toBe(false);
    const hard = attrs(html(<Button disabled>Create</Button>), /<button /);
    expect("disabled" in hard).toBe(true);
    expect("aria-disabled" in hard).toBe(false);
  });

  it("wires dialog and loading attributes", () => {
    expect(
      attrs(html(<Button opens="d">Open</Button>), /<button /)[
        "data-dialog-open"
      ],
    ).toBe("d");
    expect(
      "data-dialog-close" in
        attrs(html(<Button closes>Close</Button>), /<button /),
    ).toBe(true);
    expect(
      attrs(
        html(
          <Button type="submit" loadingLabel="Saving...">
            Save
          </Button>,
        ),
        /<button /,
      )["data-loading-label"],
    ).toBe("Saving...");
  });

  it("passes data to a select and a switch for the script that reads them", () => {
    expect(
      attrs(
        html(
          <Select
            label="Note"
            options={[{ value: "", label: "No access" }]}
            data={{ noun: "notes", held: "read" }}
          />,
        ),
        /<select /,
      ),
    ).toMatchObject({ "data-noun": "notes", "data-held": "read" });
    expect(
      attrs(
        html(<Switch id="s" data={{ phrase: "Your email address" }} />),
        /<input /,
      )["data-phrase"],
    ).toBe("Your email address");
  });

  it("puts two buttons side by side as a pair", () => {
    const out = html(
      <ButtonPair>
        <Button>Cancel</Button>
        <Button kind="primary">Approve</Button>
      </ButtonPair>,
    );
    expect(out.startsWith('<div class="pair">')).toBe(true);
    expect(out.match(/<button /g)).toHaveLength(2);
  });

  it("shows a device code as cells in two groups of four, named by the code with its dash", () => {
    const out = html(
      <CodeCells
        code="ABCD1234"
        caption="Check this code matches your device"
      />,
    );
    expect(attrs(out, /<div class="code-cells"/)).toMatchObject({
      role: "img",
      "aria-label": "ABCD-1234",
    });
    expect(out.match(/<span>/g)).toHaveLength(8);
    expect(out).toContain("Check this code matches your device");
    // The dash sits between the groups.
    expect(out).toMatch(/<span>D<\/span><i><\/i><span>1<\/span>/);
  });

  it("marks the chosen option, in groups too", () => {
    const out = html(
      <Select
        value="b"
        label="Speed"
        options={[
          { value: "a", label: "Slow" },
          {
            label: "Group",
            options: [
              { value: "b", label: "Steady" },
              { value: "c", label: "Fast" },
            ],
          },
        ]}
      />,
    );
    expect(out).toContain('<option value="b" selected="">Steady</option>');
    expect(out.match(/selected/g)).toHaveLength(1);
    expect(out).toContain('<optgroup label="Group">');
    expect(attrs(out, /<select /)["aria-label"]).toBe("Speed");
  });

  it("makes a switch a checkbox with the switch role", () => {
    const on = attrs(html(<Switch id="s" checked label="Notes" />), /<input /);
    expect(on).toMatchObject({
      type: "checkbox",
      role: "switch",
      "aria-label": "Notes",
    });
    expect("checked" in on).toBe(true);
    expect("checked" in attrs(html(<Switch id="s" />), /<input /)).toBe(false);
  });

  it("sends the value a switch was given when it is on", () => {
    expect(
      attrs(html(<Switch id="s" name="scopes" value="keys.mint" />), /<input /),
    ).toMatchObject({ name: "scopes", value: "keys.mint" });
  });
});

describe("fields", () => {
  it("labels a field and points its hint at it", () => {
    const out = html(
      <TextField id="name" name="name" label="Name" hint="Shown to apps" />,
    );
    expect(out).toContain('<label class="label" for="name">Name</label>');
    expect(attrs(out, /<input /)).toMatchObject({
      id: "name",
      name: "name",
      "aria-describedby": "name-hint",
    });
    expect(out).toContain('<p class="hint" id="name-hint">Shown to apps</p>');
    expect("aria-invalid" in attrs(out, /<input /)).toBe(false);
  });

  it("makes an input that ends a row, named by the row and not by a label of its own", () => {
    const out = html(
      <RowInput
        id="key-name"
        name="name"
        describedBy="key-name-note"
        invalid
        data={{ field: "name" }}
      />,
    );
    expect(attrs(out, /<input /)).toMatchObject({
      id: "key-name",
      name: "name",
      type: "text",
      autocomplete: "off",
      "aria-invalid": "true",
      "aria-describedby": "key-name-note",
      "data-field": "name",
    });
    expect(out).not.toContain("<label");
    expect(
      "aria-invalid" in attrs(html(<RowInput id="a" name="a" />), /<input /),
    ).toBe(false);
  });

  it("marks a field with an error invalid and shows the error in place of the hint", () => {
    const out = html(
      <TextField id="e" name="e" label="E" hint="h" error="Bad" />,
    );
    expect(attrs(out, /<input /)).toMatchObject({
      "aria-invalid": "true",
      "aria-describedby": "e-err",
    });
    expect(out).toContain('<p class="err" id="e-err">Bad</p>');
    expect(out).not.toContain("hint");
  });

  it("marks a field invalid by another field's message, with no message of its own", () => {
    const out = html(
      <TextField id="e" name="e" label="E" hint="h" invalidBy="other-err" />,
    );
    expect(attrs(out, /<input /)).toMatchObject({
      "aria-invalid": "true",
      "aria-describedby": "other-err e-hint",
    });
    expect(out).not.toContain('class="err"');
    const password = html(
      <PasswordField id="p" name="p" label="P" invalidBy="other-err" />,
    );
    expect(attrs(password, /<input /)).toMatchObject({
      "aria-invalid": "true",
      "aria-describedby": "other-err",
    });
  });

  it("puts the label's end content on the label's line", () => {
    const out = html(
      <PasswordField
        id="p"
        name="p"
        label="Password"
        labelEnd={<a href="/f">Forgot?</a>}
      />,
    );
    expect(out).toContain(
      '<div class="label-line"><label class="label" for="p">Password</label><a href="/f">Forgot?</a></div>',
    );
  });

  it("makes a password field that is a password, takes no value and starts with its toggle hidden", () => {
    const out = html(
      <PasswordField
        id="p"
        name="p"
        label="Password"
        autocomplete="current-password"
        required
      />,
    );
    const input = attrs(out, /<input /);
    expect(input).toMatchObject({
      type: "password",
      autocomplete: "current-password",
    });
    expect("value" in input).toBe(false);
    const toggle = attrs(out, /<button /);
    expect("hidden" in toggle).toBe(true);
    expect(toggle["aria-label"]).toBe("Show password");
    expect(out).toContain("data-icon-show");
  });

  it("makes a search field that is a labeled search input, with its shortcut button hidden until a script shows it", () => {
    const out = html(
      <SearchField placeholder="Search keys" value="a" shortcutHint />,
    );
    expect(attrs(out, /<input /)).toMatchObject({
      type: "search",
      name: "q",
      "aria-label": "Search keys",
      value: "a",
    });
    const open = attrs(out, /<button /);
    expect(open).toMatchObject({
      type: "button",
      "data-command-search-open": "true",
      hidden: "",
    });
    expect(open["aria-label"]).not.toBe("");
    expect(out).toMatch(
      /<button [^>]*><kbd data-shortcut-hint="true"><\/kbd><\/button>/,
    );
    const plain = html(<SearchField placeholder="s" />);
    expect(plain).not.toContain("<kbd");
    expect(plain).not.toContain("<button");
  });

  it("ends a form with its buttons, after a note", () => {
    const out = html(
      <FormFoot note="Saved">
        <Button>Cancel</Button>
        <Button kind="primary" type="submit">
          Save
        </Button>
      </FormFoot>,
    );
    expect(out).toMatch(
      /^<div class="formfoot"><span class="note">Saved<\/span><button/,
    );
    expect(out.lastIndexOf("Save")).toBeGreaterThan(out.indexOf("Cancel"));
  });
});

describe("feedback", () => {
  it("announces an error at once and an info notice politely", () => {
    expect(
      attrs(
        html(
          <Notice tone="error" title="No">
            x
          </Notice>,
        ),
        /<div /,
      ),
    ).toMatchObject({
      class: "notice error",
      role: "alert",
    });
    expect(attrs(html(<Notice>x</Notice>), /<div /)).toMatchObject({
      class: "notice",
      role: "status",
    });
  });

  it("shows an empty state's title, line and action", () => {
    const out = html(
      <EmptyState
        title="Nothing"
        description="Add one"
        action={<Button>Add</Button>}
      />,
    );
    expect(out).toContain('<div class="et">Nothing</div>');
    expect(out).toContain('<div class="ed">Add one</div>');
    expect(out).toContain("<button");
  });
});

describe("Dialog", () => {
  it("is a native dialog named by its title and described by its line", () => {
    const out = html(
      <Dialog
        id="confirm"
        title="Sure?"
        description="It cannot be undone"
        actions={<Button closes>Cancel</Button>}
      >
        body
      </Dialog>,
    );
    expect(attrs(out, /<dialog /)).toMatchObject({
      id: "confirm",
      "aria-labelledby": "confirm-title",
      "aria-describedby": "confirm-description",
    });
    expect(out).toContain('<h2 class="ctitle" id="confirm-title">Sure?</h2>');
    expect(out).toContain('id="confirm-description"');
    expect("open" in attrs(out, /<dialog /)).toBe(false);
  });

  it("leaves out the description it was not given, and its reference", () => {
    const out = html(<Dialog id="d" title="T" actions="x" />);
    expect(out).not.toContain("aria-describedby");
  });
});

describe("lists", () => {
  it("shows no pager for a list that fits one page", () => {
    expect(
      html(
        <Pager
          pagination={paginate(10, 1)}
          noun="keys"
          href={(p) => `?page=${String(p)}`}
        />,
      ),
    ).toBe("");
  });

  it("keeps the pager for a list past ten rows when one page holds it all, so the size can be changed back", () => {
    const at50 = html(
      <Pager
        pagination={paginate(30, 1, 50)}
        noun="keys"
        href={(p) => `?page=${String(p)}`}
      />,
    );
    expect(at50).toContain("1–30 of 30");
    expect(at50).toContain('name="size"');
  });

  it("shows where you are and links to the page before and after", () => {
    const out = html(
      <Pager
        pagination={paginate(42, 2)}
        noun="keys"
        href={(p) => `?page=${String(p)}`}
      />,
    );
    expect(out).toContain("11–20 of 42");
    expect(out).toContain('href="?page=1" rel="prev"');
    expect(out).toContain('href="?page=3" rel="next"');
  });

  it("offers 10, 25 and 50 rows per page, marks the one shown, and sends the form when it changes", () => {
    const out = html(
      <Pager
        pagination={paginate(120, 1, 25)}
        noun="keys"
        href={(p) => `?page=${String(p)}&size=25`}
        carry={{ q: "loop", size: "10", page: "4" }}
      />,
    );
    expect(out).toContain("Rows per page");
    // The select only works with a script, so the script shows it.
    expect(attrs(out, /<form /)).toMatchObject({
      method: "get",
      hidden: "",
      "data-script-only": "true",
    });
    const select = attrs(out, /<select /);
    expect(select).toMatchObject({ name: "size", "data-autosubmit": "" });
    expect(select["aria-label"]).toBe("Rows per page");
    expect(
      [...out.matchAll(/<option value="(\d+)"( selected(?:="[^"]*")?)?>/g)].map(
        (m) => [m[1], m[2] !== undefined],
      ),
    ).toEqual([
      ["10", false],
      ["25", true],
      ["50", false],
    ]);
    // The rest of the query rides along; the size and page it replaces do not.
    expect(attrs(out, /<input type="hidden" name="q"/)).toMatchObject({
      value: "loop",
    });
    expect(out.match(/type="hidden"/g)).toHaveLength(1);
    expect(out).toContain("1–25 of 120");
    expect(out.indexOf("Rows per page")).toBeLessThan(
      out.indexOf("1–25 of 120"),
    );
  });

  it("disables the arrow with nowhere to go", () => {
    const first = html(
      <Pager
        pagination={paginate(42, 1)}
        noun="keys"
        href={(p) => `?page=${String(p)}`}
      />,
    );
    expect(first).not.toContain('rel="prev"');
    expect(first).toMatch(
      /aria-disabled="true"[^>]*aria-label="Previous page"/,
    );
    const last = html(
      <Pager
        pagination={paginate(42, 5)}
        noun="keys"
        href={(p) => `?page=${String(p)}`}
      />,
    );
    expect(last).not.toContain('rel="next"');
    expect(last).toContain("41–42 of 42");
  });

  it("offers no way to see every row", () => {
    const out = renderFixturePage({ nonce: "abc123" });
    expect(out.toLowerCase()).not.toMatch(/show all|view all|see all/);
    expect(out.match(/href="\/fixture\/keys\/\d+"/g)?.length).toBeGreaterThan(
      0,
    );
  });

  it("marks the current tab and counts each", () => {
    const out = html(
      <Tabs
        label="Keys"
        tabs={[
          { label: "Yours", href: "?k=1", current: true, count: 3 },
          { label: "Apps", href: "?k=2", current: false },
        ]}
      />,
    );
    expect(out).toContain('aria-label="Keys"');
    expect(out).toMatch(
      /<a class="tab" href="\?k=1" aria-current="true">Yours<span class="n">3<\/span><\/a>/,
    );
    expect(out).toMatch(/<a class="tab" href="\?k=2">Apps<\/a>/);
  });

  it("makes the toolbar a GET search form with filters before the search", () => {
    const out = html(
      <ListToolbar
        label="Search keys"
        filters={
          <Select
            name="s"
            label="State"
            autosubmit
            options={[{ value: "", label: "Any" }]}
          />
        }
        search={<SearchField placeholder="Search keys" />}
      />,
    );
    expect(attrs(out, /<form /)).toMatchObject({
      method: "get",
      role: "search",
    });
    expect(out.indexOf("filters")).toBeLessThan(out.indexOf('type="search"'));
    expect("data-autosubmit" in attrs(out, /<select /)).toBe(true);
  });
});

describe("Breadcrumb", () => {
  const trail = [
    { label: "API keys", href: "/fixture/keys" },
    { label: "Key number 3" },
  ];
  const render = (extra: Partial<Parameters<typeof Breadcrumb>[0]> = {}) =>
    html(
      <Breadcrumb
        home={{ label: "Marfa", href: "/" }}
        trail={trail}
        registry={fixtureRegistry()}
        pageId="keys"
        items={{ keys: [{ title: "Key number 3", href: "/fixture/keys/3" }] }}
        currentItemHref="/fixture/keys/3"
        {...extra}
      />,
    );

  it("is the trail, with the last crumb marked as the current page", () => {
    const out = render();
    expect(attrs(out, /<nav /)["aria-label"]).toBe("Breadcrumb");
    expect(out).toMatch(/<a href="\/">Marfa<\/a>/);
    expect(out).toContain(
      '<span class="here" aria-current="page">Key number 3</span>',
    );
  });

  it("starts the picker hidden, on the last crumb, for a script to show", () => {
    const out = render();
    const button = attrs(out, /<button /);
    expect(button).toMatchObject({
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-controls": "page-picker",
    });
    expect("hidden" in button).toBe(true);
    expect("hidden" in attrs(out, /<div class="menu" /)).toBe(true);
  });

  it("lists the built pages grouped as Home groups them, and none that are not built", () => {
    const out = render();
    const labels = [
      ...out.matchAll(/<div class="menu-label">([^<]+)<\/div>/g),
    ].map((m) => m[1]);
    expect(labels).toEqual(["Access", "Your data", "This Marfa"]);
    for (const title of [
      "API keys",
      "Connected apps",
      "Items",
      "Trash",
      "All settings",
    ])
      expect(out).toContain(`<span class="grow">${title}</span>`);
    for (const title of [
      "Browsers",
      "Export and restore",
      "Connectors",
      "Folders",
      "General",
      "Profile",
    ])
      expect(out).not.toContain(title);
    expect(out).not.toContain('href="undefined"');
  });

  it("marks the page you are on", () => {
    const out = render();
    expect(out).toMatch(
      /<a class="menu-item" role="menuitem" href="\/fixture\/keys" aria-current="page"/,
    );
    expect(out.match(/aria-current="page"/g)).toHaveLength(3);
  });

  it("opens a page's items beside it one level down only, with the current item marked", () => {
    const deep = render();
    expect(attrs(deep, /<div class="menu fly"/)).toMatchObject({
      id: "page-picker-keys",
      "aria-label": "API keys",
    });
    expect(deep).toMatch(
      /href="\/fixture\/keys"[^>]*data-panel="page-picker-keys"/,
    );
    expect(deep).toMatch(/href="\/fixture\/keys\/3" aria-current="page"/);
    const shallow = render({ trail: [{ label: "API keys" }] });
    expect(shallow).not.toContain("menu fly");
    expect(shallow).not.toContain("data-panel");
  });

  it("gives a long panel a filter and a short one none", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      title: `K${String(i)}`,
      href: `/k/${String(i)}`,
    }));
    expect(render({ items: { keys: many } })).toContain("data-picker-filter");
    expect(render()).not.toContain("data-picker-filter");
  });

  it("shows no picker when the registry has no built page", () => {
    const out = render({ registry: createPageRegistry(HOME_GROUPS) });
    expect(out).not.toContain("<button");
    expect(out).not.toContain('role="menu"');
    expect(out).toContain('aria-current="page"');
  });

  it("is an empty bar on Home, which has no trail: no crumb, no landmark and no picker", () => {
    const out = render({ trail: [] });
    expect(out).toContain('<div class="crumbs"></div>');
    expect(out).not.toContain("<nav");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("Marfa");
    expect(out).not.toContain("<button");
    // Witness: with a trail the same props give the bar's crumbs.
    expect(render()).toContain("<nav");
    expect(render()).toContain("Marfa");
  });
});

describe("CommandSearch", () => {
  const render = () =>
    html(<CommandSearch registry={fixtureRegistry()} home={{ href: "/" }} />);

  it("is a native dialog holding a labeled combobox over a listbox", () => {
    const out = render();
    expect(attrs(out, /<dialog /)).toMatchObject({
      id: "command-search",
      "aria-label": "Go to a page or setting",
    });
    expect(attrs(out, /<input /)).toMatchObject({
      role: "combobox",
      "aria-controls": "cs-list",
    });
    expect(attrs(out, /<div class="pal-list"/).role).toBe("listbox");
  });

  it("holds Home and every built page, and no page that is not built", () => {
    const out = render();
    const pages = out.slice(
      out.indexOf('data-search-group="pages"'),
      out.indexOf('data-search-group="settings"'),
    );
    const titles = [...pages.matchAll(/data-title="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(titles).toEqual([
      "Home",
      "API keys",
      "Connected apps",
      "Items",
      "Trash",
      "All settings",
    ]);
  });

  it("holds the settings other pages register, with their text escaped, and none of the settings page's own", () => {
    const registry = fixtureRegistry();
    registry.register("general", {
      href: "/fixture/general",
      settings: [
        {
          id: "name",
          title: "Name <b>",
          group: "General",
          href: "/fixture/general#name",
        },
      ],
    });
    const out = html(
      <CommandSearch registry={registry} home={{ href: "/" }} />,
    );
    expect(out).toContain('id="cs-setting-general-name"');
    expect(out).toContain('data-title="Name &lt;b&gt;"');
    expect(out).not.toContain("cs-setting-settings-");
    expect(out).not.toContain("Keep items in the trash");
    expect(out).toContain('data-settings-source="/fixture/settings.json"');
  });

  it("starts with the suggested pages and every other result hidden", () => {
    const out = render();
    const suggested = out.slice(
      out.indexOf('data-search-group="suggested"'),
      out.indexOf('data-search-group="pages"'),
    );
    expect(
      [...suggested.matchAll(/data-title="([^"]*)"/g)].map((m) => m[1]),
    ).toEqual([
      "Home",
      "API keys",
      "Connected apps",
      "Items",
      "Trash",
      "All settings",
    ]);
    expect(
      attrs(out, /<div role="group" aria-labelledby="cs-label-pages"/),
    ).toHaveProperty("hidden");
    expect(out.match(/role="option"/g)?.every(() => true)).toBe(true);
  });

  it("gives every result a distinct id", () => {
    const ids = [...render().matchAll(/\sid="(cs-[^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the fixture page", () => {
  it("renders as a whole document", () => {
    const out = html(<FixturePage nonce="abc123" />);
    expect(out).toContain("<main");
    expect(out).toContain("<dialog");
    expect(out.match(/<h1/g)).toHaveLength(1);
  });
});

describe("every address a part renders is a path on this server", () => {
  const bad = [
    "/\t/evil.com",
    "//evil.com",
    "/\\evil.com",
    "javascript:alert(1)",
    "https://evil.com/",
  ];

  it.each(bad)("refuses %j in a button, a row, a tab and the pager", (href) => {
    expect(() => html(<Button href={href}>x</Button>)).toThrow(/address/i);
    expect(() => html(<Row title="t" href={href} />)).toThrow(/address/i);
    expect(() =>
      html(<Tabs label="k" tabs={[{ label: "a", href, current: true }]} />),
    ).toThrow(/address/i);
    expect(() =>
      html(
        <Pager pagination={paginate(42, 2)} noun="keys" href={() => href} />,
      ),
    ).toThrow(/address/i);
  });

  it.each(bad)(
    "refuses %j in the breadcrumb, its picker items and the home link",
    (href) => {
      const crumb = (extra: Partial<Parameters<typeof Breadcrumb>[0]>) =>
        html(
          <Breadcrumb
            home={{ label: "Marfa", href: "/" }}
            trail={[
              { label: "API keys", href: "/fixture/keys" },
              { label: "Key" },
            ]}
            registry={fixtureRegistry()}
            pageId="keys"
            {...extra}
          />,
        );
      expect(() => crumb({ home: { label: "Marfa", href } })).toThrow(
        /address/i,
      );
      expect(() =>
        crumb({ trail: [{ label: "API keys", href }, { label: "Key" }] }),
      ).toThrow(/address/i);
      expect(() => crumb({ items: { keys: [{ title: "k", href }] } })).toThrow(
        /address/i,
      );
      expect(() => crumb({ currentItemHref: href })).not.toThrow();
    },
  );

  it("refuses one in the command search's Home", () => {
    expect(() =>
      html(
        <CommandSearch
          registry={fixtureRegistry()}
          home={{ href: "//evil.com" }}
        />,
      ),
    ).toThrow(/address/i);
  });

  it("still takes a good path everywhere, and the same-page forms where a part allows them", () => {
    expect(html(<Button href="/ok">x</Button>)).toContain('href="/ok"');
    expect(html(<Button href="">x</Button>)).toContain('href=""');
    expect(html(<Row title="t" href="/ok" />)).toContain('href="/ok"');
    expect(
      html(
        <Tabs label="k" tabs={[{ label: "a", href: "?k=1", current: true }]} />,
      ),
    ).toContain('href="?k=1"');
  });
});

describe("the noscript line", () => {
  const page = (needsScript?: boolean) =>
    renderDocument(
      <PageShell title="T" nonce="abc123" needsScript={needsScript} />,
    );

  it("is on a page that needs the script, and the script is loaded", () => {
    const out = page(true);
    expect(out).toContain("<noscript>");
    expect(out).toContain("<script ");
  });

  it("is not on a page that works without it, and neither is the script", () => {
    const out = page(false);
    expect(out).not.toContain("noscript");
    expect(out).not.toContain("<script ");
  });

  it("is on by default, so a page must say it does not need the script", () => {
    expect(page()).toContain("<noscript>");
  });

  it("is left out, though the script loads, on a page the script only improves", () => {
    const out = renderDocument(
      <PageShell
        title="T"
        nonce="abc123"
        needsScript={false}
        enhancedByScript
      />,
    );
    expect(out).not.toContain("noscript");
    expect(out).toContain("<script ");
  });
});
