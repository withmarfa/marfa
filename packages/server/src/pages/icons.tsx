/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

/**
 * The fixed icon set: 16 by 16 strokes, drawn in the current text color.
 * Every name is one of these, so a page cannot ask for markup of its own.
 */
const GLYPHS = {
  chevron: <path d="M6 4l4 4-4 4" />,
  back: <path d="M10 4l-4 4 4 4" />,
  arrow: <path d="M3 8h10M9 4l4 4-4 4" />,
  down: <path d="M4 6l4 4 4-4" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </>
  ),
  alert: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 5v3.5M8 11h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.5V11M8 5h.01" />
    </>
  ),
  check: <path d="M3.5 8.5l3 3 6-7" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
      <path d="M2.5 2.5l11 11" />
    </>
  ),
  passkey: (
    <>
      <circle cx="6" cy="5" r="2.5" />
      <path d="M2 13.5c0-2.2 1.8-4 4-4 1 0 1.9.4 2.6 1" />
      <circle cx="12" cy="10" r="1.75" />
      <path d="M12 11.75V14.5m0-1.5h1.25" />
    </>
  ),
} satisfies Record<string, Child>;

export type IconName = keyof typeof GLYPHS;

export function Icon(props: { name: IconName; size?: number }) {
  const size = props.size ?? 16;
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[props.name]}
    </svg>
  );
}
