# Fonts

Self-hosted, Latin subset, woff2. Each is licensed under the SIL Open Font License 1.1
(https://openfontlicense.org); the copies come from the Fontsource packages (v5.3.0) of the same families.

| File | Family | Axes used |
| --- | --- | --- |
| `figtree-latin-wght.woff2` | Figtree (Erik Kennedy and contributors) | weight 300-900 |
| `bricolage-grotesque-latin-opsz.woff2` | Bricolage Grotesque (Mathieu Triay) | weight 200-800, optical size 12-96 |
| `jetbrains-mono-latin-500.woff2` | JetBrains Mono (JetBrains) | weight 500 |

`tokens.css` declares them with `font-display: swap`; Vite hashes them into `/assets`, so the daemon serves
them `immutable`, and the service worker precaches them. Characters outside Latin fall back to the system font.
