import type { DisplayHints } from "@withmarfa/shared";
import type { ToolContext } from "../context.js";

/**
 * The effective display hints of each of `types`, from the type itself and
 * its ancestors, as the owner console's names read them. A type the API does
 * not answer for is named without hints.
 */
export async function displayHintsOf(
  ctx: ToolContext,
  types: Iterable<string>,
): Promise<Map<string, DisplayHints | undefined>> {
  const distinct = [...new Set(types)];
  const hints = new Map<string, DisplayHints | undefined>();
  await Promise.all(
    distinct.map(async (id) => {
      const answer = await ctx.api.answer(
        ctx.api.client.GET("/types/{id}", { params: { path: { id } } }),
      );
      hints.set(id, answer.ok ? answer.data.display_hints : undefined);
    }),
  );
  return hints;
}
