# hermes-flare

Blog post: https://chad.cm/posts/2026-5-28-hermes-flare

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
git clone https://github.com/carimura/hermes-flare
cd hermes-flare
npm install

# 1. Personal IDs go in .env (gitignored).
cp .env.example .env
# edit .env: set AGENT_NAME (the Worker name) and your SLACK_ALLOWED_USERS
# (Slack member ID, U01ABC2DEF3)

# 2. Push secrets.
npx wrangler secret put ANTHROPIC_API_KEY     # sk-ant-...
npx wrangler secret put HERMES_GATEWAY_TOKEN  # `openssl rand -hex 32`
npx wrangler secret put SLACK_BOT_TOKEN       # xoxb-... (see "Slack setup")
npx wrangler secret put SLACK_APP_TOKEN       # xapp-... (see "Slack setup")

# 3. Create the R2 bucket for snapshots (shared by all agents — create once).
npx wrangler r2 bucket create hermes-flare-data

# 4. Deploy.
npm run deploy
```

First deploy builds the container image (~90s). The container won't actually start until the first request hits the Worker. Bootstrap it:

```sh
curl "https://hermes-flare.<your-subdomain>.workers.dev/api/status?token=$HERMES_GATEWAY_TOKEN"
# → {"container":"running","gateway_running":true,"pid":"proc_..."}
```

First hit takes 1-2 minutes (cold container + Hermes gateway boot). After that, the cron trigger (every 5 min) keeps the gateway alive.

### Running multiple agents

Each agent is one deployed Worker. To stand up another, clone the repo, set a
distinct `AGENT_NAME` in `.env`, push that agent's own secrets, and deploy:

```sh
git clone https://github.com/carimura/hermes-flare athena && cd athena
npm install
cp .env.example .env          # set AGENT_NAME=athena + this agent's Slack IDs
npx wrangler secret put ANTHROPIC_API_KEY    # ...and the rest, per agent
npm run deploy                # deploys a Worker named "athena"
```

No new R2 bucket is needed — all agents share `hermes-flare-data`, and each
agent's snapshots are namespaced under `<AGENT_NAME>/`. `AGENT_NAME` is the
only structural change between clones; everything else is per-agent secrets/IDs.

### Snapshots

Snapshots are automatic — no setup beyond the R2 bucket created above. The
cron (every 5 min) backs up `/home/hermes` to R2 through the bound
`BACKUP_BUCKET` binding (the SDK's `localBucket` mode), so there's no R2 API
token, account ID, or extra secret to configure. See [Persistence](#persistence).

## Deploying

`npm run deploy` is the one command. Under the hood it's `bash scripts/deploy.sh`:

1. Reads `.env` (gitignored, see `.env.example`) — your personal IDs like `SLACK_ALLOWED_USERS`.
2. Builds `--var KEY:VAL` args from those values.
3. Runs `npx wrangler deploy ...`.

Wrangler then:
- Builds two container images locally: `Dockerfile` (Hermes) and `Dockerfile.exec` (Exec).
- Pushes them to `registry.cloudflare.com`.
- Updates the Worker bundle + container application image bindings.

`npm run deploy:bare` bypasses the script and runs `wrangler deploy` directly — useful if you want to skip `.env` injection.

### After deploying

**For Worker-only changes** (routes, env-var pass-through): the Worker hot-swaps on deploy. No further action needed.

**For changes to the Hermes container** (`Dockerfile`, `start-hermes.sh`): the *Worker* updates immediately, but the running Hermes container persists with its **original image**. The new image won't be used until the container instance restarts (hibernation, OOM, manual delete). To force a fresh process inside the same container (picks up new env vars but NOT a new container image):

```sh
curl -X POST "https://hermes-flare.<your>.workers.dev/api/kill?token=$HERMES_GATEWAY_TOKEN"
```

The cron trigger (every 5 min) or the next `/api/status` will respawn the gateway.

**To force a brand-new container instance with the new image** (the nuclear option, when wrangler's image rebinding gets stuck):

```sh
npx wrangler containers delete <hermes-app-id>   # find via `wrangler containers list`
npm run deploy                                    # recreates from scratch
```

This destroys the Durable Object's container instance but leaves R2 data intact. Hermes' state survives via snapshot/restore.

### Troubleshooting

- **Deploy hangs at `<layer-id>: Retrying ... unauthorized`** — wrangler's docker-push step is retrying a layer that's actually already in the registry. Workaround: in a separate terminal, manually `docker push registry.cloudflare.com/<account>/<image>:<tag>` (tag visible in `~/Library/Preferences/.wrangler/logs/*.log`), then re-run `npm run deploy`. Wrangler's "exists?" check passes the second time and it skips the push.
- **`Modified application` but the live container still runs old code/env** — the existing container instance kept its original image. Either bounce via `/api/kill` (for env changes that flow through `start-hermes.sh`) or delete the container app + redeploy (for Dockerfile changes).

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

Defaults live in `wrangler.jsonc`; personal IDs and per-environment tweaks go in `.env` (gitignored). `npm run deploy` reads `.env` and applies values via `wrangler deploy --var`. `.env` holds **non-secret** values only — secrets always go through `wrangler secret put` (encrypted), never `.env`.

| Var | Default | Where | Purpose |
|---|---|---|---|
| `AGENT_NAME` | `hermes-flare` | `.env` | This agent's identity — names the deployed Worker and namespaces its snapshots in the shared R2 bucket. The one knob to change when cloning. |
| `SLACK_ALLOWED_USERS` | — | `.env` | Comma-separated Slack member IDs allowed to talk to the bot |
| `SLACK_HOME_CHANNEL` | — | `.env` | Slack channel ID for scheduled/cron output |
| `SLACK_REPLY_IN_THREAD` | `true` | wrangler.jsonc | `false` → post to channel top level instead of threading |
| `SANDBOX_SLEEP_AFTER` | `never` | wrangler.jsonc | `"10m"`/`"1h"` etc. to hibernate when idle |
| `SNAPSHOT_INTERVAL_MINUTES` | `240` | wrangler.jsonc | Max age (min) of the latest R2 backup before the cron re-snapshots; 240 = 4h |
| `BACKUP_RETENTION_DAYS` | `3` | wrangler.jsonc | Days of backups to retain; older ones are pruned from R2 |

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

The cron trigger runs every 5 minutes, calling `restoreIfNeeded` + `ensureGateway` — so the gateway always comes back from a kill or container restart without manual intervention. It also snapshots `/home/hermes` to R2 whenever the latest backup is older than `SNAPSHOT_INTERVAL_MINUTES` (default 240), keeping a fresh backup ahead of its TTL.

## Persistence

The Sandbox SDK has a `createBackup` / `restoreBackup` API that exports a container directory as a squashfs image to R2. We snapshot `/home/hermes` — Hermes' data dir, containing sessions, memories, learned skills, and config. On every cold container start, the Worker restores from R2 before serving the request. Without this, every restart would wipe Hermes' growing memory.

Backups go through the bound `BACKUP_BUCKET` R2 binding (the SDK's `localBucket` mode) rather than presigned URLs, so no R2 API token or account-ID secret is needed — snapshots work as soon as the bucket exists. All agents share one bucket; each agent's metadata keys are namespaced under `<AGENT_NAME>/`, and the SDK's squashfs blobs are globally unique by id.

Snapshot paths must live under `/home`, `/workspace`, `/tmp`, or `/var/tmp`. Hermes hardcodes `/opt/data` — we symlink that to `/home/hermes/.hermes` in the Dockerfile so Hermes' assumptions hold while the real data sits in a snapshot-eligible path.

## Design notes

### Why `cloudflare/sandbox` base, not `nousresearch/hermes-agent`

The Sandbox SDK's snapshot API requires the `cloudflare/sandbox` base image — it ships the squashfs tooling (`mksquashfs`/`unsquashfs`) the snapshot system uses. We install Hermes on top of that base rather than starting from Nous's official image.

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
hermes-flare/
├─ README.md
├─ LICENSE                  # Apache 2.0
├─ Dockerfile               # cloudflare/sandbox:0.10.3 + Hermes install
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
   ├─ sandbox.ts            # exports Agent = SDK Sandbox class
   └─ persistence.ts        # createSnapshot / restoreIfNeeded
```

## License

Apache 2.0 — see [LICENSE](./LICENSE).
