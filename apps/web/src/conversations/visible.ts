// Control, bidi and zero-width characters, made visible (see `visible`).

/**
 * Shows control and format characters as `⟨U+202E⟩` instead of acting on them, so a path like "src/‮gnp.exe"
 * cannot read as "src/exe.png" and nothing hides in a command or a diff. Used for everything a person decides
 * on: permission cards, tool details, paths, the plan, titles. Tabs and line breaks stay. In a title, the
 * zero-width joiners that build emoji (U+200D, U+200C) may stay (`keepJoiners`).
 */
export function visible(text: string, keepJoiners = false): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => {
    if (ch === "\n" || ch === "\t" || ch === "\r") return ch;
    if (keepJoiners && (ch === "\u200d" || ch === "\u200c")) return ch;
    return `⟨U+${ch.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}⟩`;
  });
}
