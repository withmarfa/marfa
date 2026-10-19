/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */

export interface CodeCellsProps {
  /** The code a device shows, such as `ABCD1234`: eight characters, two groups of four. */
  code: string;
  /** Says what to do with the code, above it. */
  caption: string;
}

/**
 * A code for a person to compare with the one on their device: one cell for
 * each character, in two groups of four with a dash between. A screen reader
 * reads it as one picture named by the code with its dash.
 */
export function CodeCells(props: CodeCellsProps) {
  const characters = Array.from(props.code);
  const first = characters.slice(0, 4);
  const second = characters.slice(4);
  return (
    <div class="stack-8">
      <p class="caption">{props.caption}</p>
      <div
        class="code-cells"
        role="img"
        aria-label={`${first.join("")}-${second.join("")}`}
      >
        {first.map((character) => (
          <span>{character}</span>
        ))}
        <i />
        {second.map((character) => (
          <span>{character}</span>
        ))}
      </div>
    </div>
  );
}
