export function fixtureTitles(text: string, includeDescribe = false): string[] {
  return [
    ...text.matchAll(
      /(?:^|\s)(it|describe|it\.each\([^)]*\))\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g,
    ),
  ]
    .filter((m) => includeDescribe || m[1] !== "describe")
    .map((m) => (m[2] ?? m[3]).replace(/\\`/g, "`"));
}
