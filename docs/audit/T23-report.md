# T23 — Colour system regression tests and needs-you contrast

## Current main comparison

Checked against freshly fetched `origin/main` at `f140938` before editing. The test and token
files were identical to this branch's starting versions.

- Theme parsing was still broken: the light section included the automatic-dark block.
- The list-order test still compared repeated calls rather than rendered order.
- Bar-pair and media-block tests were **already present** on main. Strengthened them rather than
  adding duplicate tests: bars now cover actual track aliases and surfaces in all three blocks;
  automatic-dark and explicit-dark maps must match in both directions.
- Light `--needs-edge` was still `#c48a12`: 2.90:1 on surface, 2.86:1 on needs-surface,
  and 2.49:1 on needs-bg.

## Change and evidence

Read each root declaration block independently. Render badge lists in two orders into the same
container and check names and fixed expected hue classes. Resolve bar-track's `var(--line)` alias
before calculating contrast. Test needs-you borders against needs-bg, needs-surface, surface and
ground, then darken only the light border to `#ac780f` (minimum 3.19:1 across those backgrounds).
The owner can choose another amber provided all four contrast assertions pass.

The new border regression failed before the colour change (2.49 < 3). Temporary mutations of
light chip foreground, project foreground, and bar fill each made their corresponding existing
contrast test fail; all mutations were restored. The focused suite passes all 10 tests.

Built the web app. Rendered representative needs-you card/chip token samples at 390×844 and
1440×900 with the repository UI checker and inspected both screenshots: no findings. This is a
token-only visual review, not a full application interaction check. Risk is limited to the slightly
darker amber border in light mode.

Required checks all passed on this worktree: `pnpm install --frozen-lockfile`, `pnpm check`,
`pnpm typecheck`, and `pnpm test` (including host scripts). Biome emitted two informational
suggestions in unchanged daemon tests; no errors. No branch was pushed.
