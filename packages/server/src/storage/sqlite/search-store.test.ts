import { describe, expect, it } from "vitest";
import { snippetHtml } from "./search-store.js";

describe("snippetHtml", () => {
  it("escapes the text and turns the match markers into tags", () => {
    expect(snippetHtml(`<b>numbat</b> & "q" 'p'`)).toBe(
      "&lt;b&gt;<mark>numbat</mark>&lt;/b&gt; &amp; &quot;q&quot; &#39;p&#39;",
    );
  });

  it("makes only well-formed marks from markers the text holds itself", () => {
    expect(snippetHtml("a b c d")).toBe(
      "a <mark>b</mark> c <mark>d</mark>",
    );
  });
});
