# hermes-cloudflare

Run [Nous Research's Hermes Agent](https://hermes-agent.nousresearch.com/) inside a Cloudflare Sandbox container, with state persisted to R2 via the Sandbox SDK's snapshot API. Slack connects via Socket Mode (WebSocket out from the container) — no public webhook URL needs to be registered with Slack.

Architectural patterns lifted from [`cloudflare/moltworker`](https://github.com/cloudflare/moltworker) (Apache 2.0); code written from scratch.

## Architecture

```
              Slack  ◀──── Socket Mode WebSocket ────▶
                                                       ┌─────────────────────────┐
                                                       │  Hermes Agent (Python)  │
                                                       │  /home/hermes/.hermes   │ ◀── all stateful data
                                                       └────────────┬────────────┘
                                                                    │
                                                       ┌─────────────────────────┐
                                                       │  Cloudflare Sandbox     │
                                                       │  container (DO-backed)  │
                                                       └────────────┬────────────┘
                                                                    │ Sandbox SDK
                                                                    ▼
   user ───── /api/* (token-gated) ─────▶  Cloudflare Worker (Hono router)
                                                                    │
                                                                    ▼
                                                       R2 bucket (squashfs snapshots
                                                       of /home/hermes, for persistence)
```

## Requirements

- **Cloudflare Workers Paid plan** ($5/mo — required for Sandbox containers).
- **Anthropic API key** (Hermes uses Claude by default; other providers also supported).
- **Slack workspace** where you can install apps.

Approximate runtime cost on top of the $5 plan, on a `standard-1` instance (1/2 vCPU, 4 GiB RAM, 8 GB disk):

| Usage | Approx $/mo |
|---|---|
| Container always-on (24/7) | $34 |
| Container active ~4 hrs/day | $10-12 |
| Mostly idle, webhook-driven bursts | $5-7 |

(If you don't need Cloudflare specifically, a $5/mo Hetzner/DO VPS running the official `nousresearch/hermes-agent` Docker image is the simpler, cheaper option.)

## Quick start

```sh
git clone https://github.com/carimura/hermes-cloudflare
cd hermes-cloudflare
npm install

# 1. Personal IDs go in .env (gitignored).
cp .env.example .env
# edit .env: add your SLACK_ALLOWED_USERS (Slack member ID, U01ABC2DEF3)

# 2. Push secrets.
npx wrangler secret put ANTHROPIC_API_KEY     # sk-ant-...
npx wrangler secret put HERMES_GATEWAY_TOKEN  # `openssl rand -hex 32`
npx wrangler secret put SLACK_BOT_TOKEN       # xoxb-... (see "Slack setup")
npx wrangler secret put SLACK_APP_TOKEN       # xapp-... (see "Slack setup")

# 3. Create the R2 bucket for snapshots.
npx wrangler r2 bucket create hermes-cloudflare-data

# 4. Deploy.
npm run deploy
```

First deploy builds the container image (~90s). The container won't actually start until the first request hits the Worker. Bootstrap it:

```sh
curl "https://hermes-cloudflare.<your-subdomain>.workers.dev/api/status?token=$HERMES_GATEWAY_TOKEN"
# → {"container":"running","gateway_running":true,"pid":"proc_..."}
```

First hit takes 1-2 minutes (cold container + Hermes gateway boot). After that, the cron trigger (every 5 min) keeps the gateway alive.

## Slack setup

Hermes' Slack adapter uses **Socket Mode**, not webhooks — Hermes opens a WebSocket out to Slack. No public URL is registered with Slack.

1. Generate the app manifest. Easiest: deploy first, then `curl /api/slack-manifest?token=...` to get one tailored to Hermes' current capabilities. The file `slack-manifest.json` checked into this repo is a reference snapshot.
2. https://api.slack.com/apps → **Create New App** → **From an app manifest** → paste the JSON → Create.
3. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** → add `connections:write` → copy `xapp-...` → this is `SLACK_APP_TOKEN`.
4. **OAuth & Permissions** → **Install to Workspace** → copy Bot User OAuth Token (`xoxb-...`) → this is `SLACK_BOT_TOKEN`.
5. **App Home** → **Show Tabs** → enable **Messages Tab** + "Allow users to send Slash commands and messages from the messages tab" (required for DMs).
6. In Slack, click your avatar → View full profile → ⋮ → **Copy member ID**. Put it in `.env` as `SLACK_ALLOWED_USERS`.
7. Push the secrets and `npm run deploy`.

DM the bot in Slack — first message wakes the container (1-2 min), subsequent ones are fast.

## Configuration

### Secrets (`wrangler secret put`)

| Secret | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Forwarded into the container; Hermes uses for inference |
| `HERMES_GATEWAY_TOKEN` | yes | Gates all `/api/*` routes. Pick any random value. |
| `SLACK_BOT_TOKEN` | yes (Slack) | `xoxb-...` |
| `SLACK_APP_TOKEN` | yes (Slack) | `xapp-...` with `connections:write` scope |
| `TELEGRAM_BOT_TOKEN` | optional | Reserved for future Telegram support |
| `DISCORD_BOT_TOKEN` | optional | Reserved for future Discord support |

### Non-secret vars

Defaults live in `wrangler.jsonc`; personal IDs and per-environment tweaks go in `.env` (gitignored). `npm run deploy` reads `.env` and applies values via `wrangler deploy --var`.

| Var | Default | Where | Purpose |
|---|---|---|---|
| `SLACK_ALLOWED_USERS` | — | `.env` | Comma-separated Slack member IDs allowed to talk to the bot |
| `SLACK_HOME_CHANNEL` | — | `.env` | Slack channel ID for scheduled/cron output |
| `SLACK_REPLY_IN_THREAD` | `true` | wrangler.jsonc | `false` → post to channel top level instead of threading |
| `SANDBOX_SLEEP_AFTER` | `never` | wrangler.jsonc | `"10m"`/`"1h"` etc. to hibernate when idle |

## Endpoints

All `/api/*` routes require `?token=$HERMES_GATEWAY_TOKEN`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/health` | Worker liveness; doesn't wake the container; no token required |
| GET | `/api/status` | Wakes the container, ensures the Hermes gateway is running |
| GET | `/api/logs` | Processes, listening ports, current config.yaml, recent Hermes logs |
| GET | `/api/slack-manifest` | Generated Slack app manifest from `hermes slack manifest` |
| POST | `/api/snapshot` | Snapshot `/home/hermes` to R2 |
| POST | `/api/kill` | Kill the gateway process (cron will revive it within 5 min) |

The cron trigger runs every 5 minutes, calling `restoreIfNeeded` + `ensureGateway` — so the gateway always comes back from a kill or container restart without manual intervention.

## Persistence

The Sandbox SDK has a `createBackup` / `restoreBackup` API that exports a container directory as a squashfs image to R2. We snapshot `/home/hermes` — Hermes' data dir, containing sessions, memories, learned skills, and config. On every cold container start, the Worker restores from R2 before serving the request. Without this, every restart would wipe Hermes' growing memory.

Snapshot paths must live under `/home`, `/workspace`, `/tmp`, or `/var/tmp`. Hermes hardcodes `/opt/data` — we symlink that to `/home/hermes/.hermes` in the Dockerfile so Hermes' assumptions hold while the real data sits in a snapshot-eligible path.

## Design notes

### Why `cloudflare/sandbox` base, not `nousresearch/hermes-agent`

The Sandbox SDK's snapshot API requires the `cloudflare/sandbox` base image — it ships the FUSE machinery the snapshot system uses. We install Hermes on top of that base rather than starting from Nous's official image.

### Why the Worker starts Hermes, not a Dockerfile `CMD`

The Worker calls `sandbox.startProcess(...)` to launch `start-hermes.sh`, rather than relying on a Dockerfile `CMD`. That gives us stdout/stderr capture (surfaced via `/api/logs`) and explicit lifecycle control.

### Why process-list liveness, not port probe

Hermes' Slack adapter uses Socket Mode — no listening port inside the container. Liveness is "is there a `start-hermes.sh` process in `running`/`starting` status," checked via `sandbox.listProcesses()`.

## Local dev

```sh
cp .dev.vars.example .dev.vars   # fill in real values
npm run dev
```

`wrangler dev` runs the Worker on localhost; container builds locally. Use [ngrok](https://ngrok.com/) if you need a public URL for any reason — note that Slack itself works fine without one thanks to Socket Mode.

## Known limitations

- **Slack channel messages require `@mention`.** Hermes' Slack adapter always requires an initial `@mention` in channels — there's no config flag to disable. Follow-up messages in the same thread don't need it. DMs work without mentions.
- **No automated tests.**
- **Token in query string** is leaky over time (CDN logs, referrer headers). For production, layer [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) on `/api/*`.

## Project layout

```
hermes-cloudflare/
├─ README.md
├─ LICENSE                  # Apache 2.0
├─ Dockerfile               # cloudflare/sandbox:0.7.20 + Hermes install
├─ start-hermes.sh          # container entrypoint
├─ slack-manifest.json      # reference; generate fresh via /api/slack-manifest
├─ wrangler.jsonc
├─ package.json
├─ tsconfig.json
├─ .env.example
├─ scripts/
│  └─ deploy.sh             # reads .env, applies --var, deploys
└─ src/
   ├─ index.ts              # Hono router, Worker entry, ensureGateway
   ├─ env.ts                # bindings type
   ├─ sandbox.ts            # exports HermesSandbox = SDK Sandbox class
   └─ persistence.ts        # createSnapshot / restoreIfNeeded
```

## License

Apache 2.0 — see [LICENSE](./LICENSE).
