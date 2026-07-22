# apps/desktop — placeholder

Native desktop client for Ranksta's Paradise. This directory is a placeholder
for the Effect v4 monorepo rewrite (PLO-263); no code lives here yet.

The desktop app consumes the same HTTP server as the TUI and web frontends
(see ADR 0001) via a plain-text feed surface (`/pages.txt`, `/tui/*.txt`,
`/sites.txt`) for the app-core subset that has no JSON parser. It is intentionally
not part of the TypeScript build graph.
