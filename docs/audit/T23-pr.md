# fix(web): make colour regression tests exercise each theme

The light token map included automatic-dark declarations, so light contrast assertions tested
dark values. Parse each root block independently, check rendered badge order and fixed hue
classes, and darken light `--needs-edge` from `#c48a12` to `#ac780f` so its minimum tested
contrast is 3.19:1.

## Comparison against main

All ticket items were checked against main at
`f1409389ce3a74402d640317dfa268165f88ddcf` before implementation; remote main still points
there at review round 1.

| Ticket item | Main baseline | Result |
| --- | --- | --- |
| Isolate light tokens from dark declarations | Broken CSS split | Read three independent root blocks; light assertions exercise light values. |
| Check list order | Repeated function calls | Render both orders into the same container and assert names and expected hue classes. |
| Add bar-pair tests | Already present on main | Strengthen existing coverage with resolved track aliases and surfaces in all three blocks. |
| Add media-block tests | Already present on main | Strengthen existing coverage with complete equality between automatic-dark and explicit-dark maps. |
| Light needs-you edge contrast ≥3:1 | Below threshold | Darken the light border; test needs-bg, needs-surface, surface and ground. |

## Validation

`pnpm install --frozen-lockfile`, `pnpm check`, `pnpm typecheck`, and `pnpm test` pass.
The web build and token sample screenshot review also passed during implementation.
See [the audit report](T23-report.md) for contrast mutation checks and visual review scope.
