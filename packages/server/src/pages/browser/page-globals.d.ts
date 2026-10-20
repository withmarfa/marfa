/**
 * The few browser globals the tests' `page.evaluate` callbacks touch. The
 * callbacks run in the browser, but this program is the server's, whose
 * types conflict with the full DOM library, so only what is used is declared.
 */
interface BrowserStyle {
  backgroundColor: string;
  color: string;
  colorScheme: string;
  fontSize: string;
  outlineStyle: string;
  outlineWidth: string;
  boxShadow: string;
}
interface BrowserElement {
  id: string;
  tagName: string;
  className: string;
  textContent: string;
  tabIndex: number;
  open: boolean;
  disabled: boolean;
  parentElement: BrowserElement | null;
  classList: { contains(name: string): boolean };
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  contains(other: BrowserElement | null): boolean;
  closest(selector: string): BrowserElement | null;
  checkVisibility(): boolean;
  focus(): void;
  getBoundingClientRect(): {
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
  };
  querySelector(selector: string): BrowserElement | null;
  querySelectorAll(selector: string): BrowserElement[];
  childNodes: { nodeType: number; textContent: string | null }[];
}
declare const document: {
  activeElement: BrowserElement | null;
  body: BrowserElement;
  documentElement: BrowserElement & { scrollWidth: number };
  getElementById(id: string): BrowserElement | null;
  querySelector(selector: string): BrowserElement | null;
  querySelectorAll(selector: string): BrowserElement[];
  addEventListener(
    type: string,
    listener: (event: {
      violatedDirective: string;
      blockedURI: string;
    }) => void,
  ): void;
};
declare const window: {
  innerWidth: number;
  __violations?: string[];
  __injected?: unknown;
};
declare const navigator: { platform: string };
declare function getComputedStyle(element: BrowserElement): BrowserStyle;
