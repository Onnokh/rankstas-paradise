# Native app feed contract

The native desktop client (`sleevy-native-proto`, tracked out-of-repo) has an
app-core subset with **no JSON parser** and only byte-level string tooling. So
the hosted server pre-renders every view as a plain-text document the app splits
and displays. This file is the wire contract for that surface.

Source of truth: `apps/server/src/native-feed.ts` (the feed grammar and every
rendered byte) and the text-feed handlers in `apps/server/src/http/handlers.ts`.
The formats below are the ones the server actually emits; keep this doc in step
with that code.

## Endpoints

All feed endpoints are served by the same bearer-gated server and, like every
other route, require `Authorization: Bearer <RP_TOKEN>` (see ADR 0001). Content
type is `text/plain`.

| Endpoint | Query | Body |
|---|---|---|
| `GET /sites.txt` | — | the configured site catalog |
| `GET /pages.txt` | `site`, `window` (days, default 28) | pipe-delimited page lines |
| `GET /tui/home.txt` | `site` | full "home" view feed |
| `GET /tui/opportunities.txt` | `site` | opportunities view feed |
| `GET /tui/history.txt` | `site` | daily-history view feed |
| `GET /tui/registry.txt` | `site` | registry view feed |
| `GET /tui/log.txt` | `site` | activity-log view feed |

`site` is a configured site id; site-scoped feeds require it.

## `sites.txt` — the site catalog

One line per configured site, tab-separated, no header:

```
<id> <TAB> <name>
```

Example:

```
sleevy	Sleevy
```

The app uses the id for the `?site=` query on every other feed and the name for
display.

## `pages.txt` — pipe-delimited page lines

A `latest=…|window=…` header line, then one pipe-delimited line per page:

```
latest=<latestDate>|window=<start>..<end>
<path>|<clicks>|<impressions>|<ctr%>|<position>
```

Example:

```
latest=2026-07-12|window=2026-06-15..2026-07-12
/chrome-extension|1239|28490|4.3%|5.4
/|40|4641|0.9%|15.1
```

Metrics prefer `trueTotals` and fall back to `allQueries` for the current window;
CTR is a one-decimal percentage, position one decimal.

## `tui/*.txt` — the tab-separated view feeds

Each `/tui/<view>.txt` is a tab-separated document (grammar **v2** — typed
detail nodes). Every line is `<kind> <TAB> …`. Dynamic text is scrubbed of
tabs/newlines/CRs so the line format always holds.

**List section** (one document has exactly one):

```
header  <TAB> <one header line>
meta    <TAB> <label> <TAB> <value> <TAB> <delta> <TAB> <tone>     (summary cards; delta is "—" when none)
head    <TAB> <c0> <TAB> <c1> … <TAB> <c5>                          (column titles; always 6 columns)
row     <TAB> <id> <TAB> <c0> … <TAB> <c5> <TAB> <url> <TAB> <icon> <TAB> <tone>   (url empty when not openable)
```

**Detail nodes**, emitted after the rows. Every detail node carries the owning
`row` `<id>` and a `<slot>` (`main` or `rail`; `rail` is the fixed-width detail
right rail, default `main`):

```
dtitle  <TAB> <id> <TAB> <slot> <TAB> <panel title>
dsect   <TAB> <id> <TAB> <slot> <TAB> <section heading, pre-uppercased>
dtext   <TAB> <id> <TAB> <slot> <TAB> <prose paragraph line>
dlist   <TAB> <id> <TAB> <slot> <TAB> <list item text>
dinfo   <TAB> <id> <TAB> <slot> <TAB> <info line>
dchip   <TAB> <id> <TAB> <slot> <TAB> <chip text>
dkv     <TAB> <id> <TAB> <slot> <TAB> <label> <TAB> <value> <TAB> <tone>
dmetric <TAB> <id> <TAB> <slot> <TAB> <label> <TAB> <value> <TAB> <delta> <TAB> <tone>
dspark  <TAB> <id> <TAB> <slot> <TAB> <label> <TAB> <v0,v1,…>   (integer CSV series)
```

`tone ∈ up | down | flat | warn | ""` — the app maps `up`→success,
`down`→destructive, `warn`→warning; empty is neutral. Text nodes emit a single
space when their text is empty so the field count stays fixed.

All report formatting happens server-side; the native app only splits bytes,
routes each row's selection to the matching detail lines, and charts the `dspark`
integer series.

## What `sleevy-native-proto` needs to change (out-of-repo)

The prototype was built against the old local-only server (loopback, no auth).
To hit the hosted, bearer-gated server two things change in its HTTP layer:

- **Base URL** — point it at the deployment (`https://rp.<your-domain>`) instead
  of `http://localhost:<port>`.
- **Bearer token** — send `Authorization: Bearer <RP_TOKEN>` on **every**
  request; the server fails closed (401 without/with a wrong token, 503 if the
  server itself has no `RP_TOKEN` configured).

The feed grammar itself is unchanged, so only the transport (base URL + auth
header) needs updating.
