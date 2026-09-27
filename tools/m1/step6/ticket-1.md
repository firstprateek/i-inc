Ticket #1 · Duet · docs · Low effort
README: list the lint and typecheck commands under Development

The README's Development section shows `pnpm install`, `pnpm test`, `pnpm dev:web`, `pnpm dev` and
`pnpm site`, and the paragraph under it says CI runs lint, types and tests. The two other checks CI
runs, `pnpm lint` and `pnpm typecheck`, aren't listed.

Done when:
- the Development code block lists `pnpm lint` and `pnpm typecheck`, each with a short comment in
  the same style as the lines around it;
- the commands match the scripts in package.json;
- nothing but README.md changes.
