# Ranksta's Paradise runs as a hosted service, not a local-only tool

## Status

accepted

## Context

The original design (see [agent-interface-design.md](../agent-interface-design.md)) deliberately made three choices, all justified by "this is a local-only tool driven by one person on one Mac":

- **Local-only** — the HTTP API binds `127.0.0.1` with no auth; the OAuth token, SQLite, and registry CSV live under `~/.config/rankstas-paradise`.
- **No daemon/cron** — sync was moved off launchd onto TUI startup, so data refreshes only when someone opens the dashboard.
- **MCP not needed** — "a JSON CLI is directly usable from a skill via Bash… Revisit only if multiple concurrent agents need shared long-lived access."

A new requirement invalidates all three: **opencode agents running autonomously on a Coolify box** need to read SEO data, act on an opportunity by opening a PR in a *website* repo, and write the action back to RP — all while the Mac may be **asleep or off**. Opportunistic, Mac-tied sync and a loopback-only, unauthenticated API cannot serve an always-on remote caller.

## Decision

Move RP's home to Coolify and make everything else a client.

- **Topology.** RP is deployed as a Coolify service in Digital Home. It owns the OAuth token, SQLite, and registry on a **persistent volume**. It is the only process that touches Google or the data files.
- **Surfaces** are thin adapters over the existing `service.ts` core:
  - **HTTP + bearer** for the apps — the Mac TUI and desktop app become clients. The TUI is refactored from direct SQLite/CSV reads to `fetch`.
  - **MCP + bearer** (`/mcp`, remote streamable HTTP) for agents — tools mirror the service functions (reads: `status`, `pages`, `page`, `opportunities`, `registry`, `queries`, `log list`; writes: `log add`, `registry add/set`).
  - **CLI** demoted to occasional manual use; remote mode via `RP_API_URL`/`RP_TOKEN` (env, wins) or a client config written by `rp init`.
- **Auth.** One public URL behind Coolify's proxy (TLS), a single static **bearer token required on every request** — no internal/external distinction, to keep the check to one branch.
- **Google.** The token is minted once on the Mac (the existing browser flow) and seeded onto the volume; refresh is headless thereafter. The OAuth consent screen must be **"In production"** — a "Testing" app's refresh token expires after 7 days, which would look like a random weekly outage.
- **Sync.** A Coolify **scheduled task** hits the existing `POST /api/jobs/sync` daily, per-site, carrying the bearer token — reusing what's already built rather than adding an in-process timer.
- **Out of scope for RP.** The PR loop. opencode owns opening threads in the website repos, git credentials, and PRs. RP only advises and records.

## Consequences

- The "no daemon" instinct that drove the launchd removal was Mac-specific; on an always-on box it no longer applies, so scheduled sync returns — as infra config, not code.
- Client config splits from server config: apps/agents need only `{ apiUrl, token }`; the Google creds never leave the server.
- The registry CSV is no longer human-editable in a text editor and is not version-controlled — the volume is the single source of truth. Durability rests on a volume backup, not git.
- The TUI now requires internet to open, the same constraint the remote runs already carry.
