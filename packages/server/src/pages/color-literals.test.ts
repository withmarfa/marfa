/**
 * Only `styles/tokens.css` may hold a color. Every other stylesheet and every
 * component takes its colors from the tokens, so a theme is one file and a
 * page cannot be right in light mode and wrong in dark.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const PAGES = fileURLToPath(new URL(".", import.meta.url));

const NAMED = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue " +
    "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey " +
    "darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray " +
    "darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen " +
    "fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen " +
    "lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
    "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
    "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
    "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver " +
    "skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen"
  ).split(" "),
);

const HEX =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g;
const FUNCTION =
  /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/g;
const NAMED_IN_CODE =
  /\b(?:fill|stroke|color|background|background-color|border|border-color)\s*[=:]\s*["']?([a-z]+)\b/gi;

/** The color literals in `source`, one entry for each. */
function findColorLiterals(source: string, kind: "css" | "code"): string[] {
  const text =
    kind === "css" ? source.replace(/\/\*[\s\S]*?\*\//g, "") : source;
  const found = [...text.matchAll(HEX), ...text.matchAll(FUNCTION)].map(
    (m) => m[0],
  );
  if (kind === "css") {
    for (const [, value] of text.matchAll(
      /(?:^|[;{\s])(?:--)?[a-z-]+\s*:\s*([^;{}]+)/g,
    ))
      for (const word of (value ?? "").split(/[^a-zA-Z]+/))
        if (NAMED.has(word.toLowerCase())) found.push(word);
  } else {
    for (const [, word] of text.matchAll(NAMED_IN_CODE))
      if (NAMED.has((word ?? "").toLowerCase())) found.push(word ?? "");
  }
  return found;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Files that make a page and are not the tokens, a test or a generated file. */
function pageSources(root: string, tokens: string): string[] {
  return walk(root).filter((path) => {
    const name = relative(root, path).split(sep).join("/");
    return (
      /\.(css|tsx?)$/.test(name) &&
      !/\.test\.tsx?$/.test(name) &&
      !name.includes(".generated.") &&
      name !== tokens
    );
  });
}

/** Every file under `root` that holds a color literal, with what it holds. */
function offenders(root: string, tokens: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const path of pageSources(root, tokens)) {
    const found = findColorLiterals(
      readFileSync(path, "utf8"),
      path.endsWith(".css") ? "css" : "code",
    );
    if (found.length > 0)
      out[relative(root, path).split(sep).join("/")] = found;
  }
  return out;
}

describe("color literals", () => {
  it("are in the tokens file and nowhere else in the page system", () => {
    const sources = pageSources(PAGES, "styles/tokens.css").map((p) =>
      relative(PAGES, p),
    );
    // The walk has to have found the files this rule is about.
    expect(sources).toContain(join("styles", "parts.css"));
    expect(sources).toContain(join("parts", "shell.tsx"));
    expect(sources).toContain(join("client", "picker.ts"));
    expect(offenders(PAGES, "styles/tokens.css")).toEqual({});
  });

  it("are in no component outside the page system either", () => {
    const components = walk(SRC).filter(
      (path) =>
        path.endsWith(".tsx") &&
        !path.endsWith(".test.tsx") &&
        !path.startsWith(PAGES),
    );
    expect(components.map((p) => relative(SRC, p))).toContain(
      join("routes", "http-error-page.tsx"),
    );
    const found = Object.fromEntries(
      components
        .map(
          (path) =>
            [
              relative(SRC, path),
              findColorLiterals(readFileSync(path, "utf8"), "code"),
            ] as const,
        )
        .filter(([, list]) => list.length > 0),
    );
    expect(found).toEqual({});
  });

  it("the tokens file does hold them, so the scan is looking at something", () => {
    const tokens = readFileSync(join(PAGES, "styles", "tokens.css"), "utf8");
    expect(findColorLiterals(tokens, "css").length).toBeGreaterThan(40);
  });
});

describe("the color scan", () => {
  it.each([
    ["a hex color", ".a { color: #ff0000; }", "css"],
    ["a short hex color", ".a { color: #f00; }", "css"],
    ["an eight digit hex color", ".a { color: #ff000080; }", "css"],
    ["rgb()", ".a { color: rgb(255 0 0); }", "css"],
    ["rgba()", ".a { box-shadow: 0 0 1px rgba(0, 0, 0, .5); }", "css"],
    ["hsl()", ".a { color: hsl(0 100% 50%); }", "css"],
    ["oklch()", ".a { color: oklch(0.6 0.2 30); }", "css"],
    ["a named color", ".a { color: white; }", "css"],
    ["a named color in a border", ".a { border: 1px solid black; }", "css"],
    ["a custom property holding a color", ".a { --mine: tomato; }", "css"],
    ["a hex color in a component", 'const a = <svg fill="#ff0000" />;', "code"],
    [
      "a function color in a component",
      'const style = "color: rgba(0,0,0,.5)";',
      "code",
    ],
    [
      "a named color in a component",
      'const a = <path stroke="red" />;',
      "code",
    ],
    ["a color set from script", 'el.style.color = "#fff";', "code"],
  ] as const)("finds %s", (_name, source, kind) => {
    expect(findColorLiterals(source, kind).length).toBeGreaterThan(0);
  });

  it.each([
    [
      ".a { color: var(--fg); background: transparent; fill: currentColor; }",
      "css",
    ],
    [
      ".a { font-family: -apple-system, system-ui, sans-serif; white-space: nowrap; }",
      "css",
    ],
    ["/* white #fff rgba(0,0,0) in a comment */ .a { color: inherit; }", "css"],
    ['const a = <a href="#main" fill="none" stroke="currentColor" />;', "code"],
  ] as const)("leaves alone %s", (source, kind) => {
    expect(findColorLiterals(source, kind)).toEqual([]);
  });

  it("fails the check on a stylesheet and on a component that carry one", () => {
    const root = mkdtempSync(join(tmpdir(), "marfa-colors-"));
    try {
      mkdirSync(join(root, "styles"));
      mkdirSync(join(root, "parts"));
      writeFileSync(
        join(root, "styles", "tokens.css"),
        ":root { --fg: #0a0a0a; }",
      );
      writeFileSync(
        join(root, "styles", "parts.css"),
        ".a { color: var(--fg); }",
      );
      writeFileSync(join(root, "parts", "a.tsx"), "export const a = 1;");
      expect(offenders(root, "styles/tokens.css")).toEqual({});

      writeFileSync(
        join(root, "styles", "parts.css"),
        ".a { color: #ff0000; }",
      );
      writeFileSync(
        join(root, "parts", "a.tsx"),
        'export const a = <path fill="rgb(1 2 3)" />;',
      );
      expect(offenders(root, "styles/tokens.css")).toEqual({
        "styles/parts.css": ["#ff0000"],
        "parts/a.tsx": ["rgb("],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
