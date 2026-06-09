import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  /**
   * This agent's identity. Doubles as (a) the deployed Worker name and (b) the
   * R2 key namespace, so all agents can share one bucket without colliding.
   * Set once in `.env`; scripts/deploy.sh applies it as `--name` + `--var`.
   * Defaults to "hermes-flare" in wrangler.jsonc.
   */
  AGENT_NAME?: string;

  // The Sandbox Durable Object namespace, bound in wrangler.jsonc.
  Agent: DurableObjectNamespace<Sandbox>;

  // Isolated sandbox where Hermes-issued shell commands run.
  // Stage 1: single shared instance. Stage 2: per-command instances.
  Exec: DurableObjectNamespace<Sandbox>;

  // R2 bucket where snapshots are stored. @cloudflare/sandbox expects
  // this binding name.
  BACKUP_BUCKET: R2Bucket;

  // --- Secrets forwarded into the container at startup ---
  ANTHROPIC_API_KEY: string;
  HERMES_GATEWAY_TOKEN: string;

  // Slack uses Socket Mode (WebSocket from container to Slack). We need
  // BOTH a bot token (xoxb-) and an app-level token (xapp-) with the
  // connections:write scope.
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  /** Comma-separated Slack member IDs (U01ABC2DEF3) allowed to talk to the bot. From vars. */
  SLACK_ALLOWED_USERS?: string;
  /** "false" → Hermes replies in the channel; "true" → in a thread. From vars. */
  SLACK_REPLY_IN_THREAD?: string;
  /** Slack channel ID for scheduled/cron messages. Optional. From vars. */
  SLACK_HOME_CHANNEL?: string;

  TELEGRAM_BOT_TOKEN?: string;
  DISCORD_BOT_TOKEN?: string;

  // --- Container behavior ---
  /** "never" (default) keeps the container warm. Set "10m", "1h", etc. to hibernate. */
  SANDBOX_SLEEP_AFTER?: string;

  /** Minutes the latest R2 backup may age before the cron re-snapshots. Default 240 (4h). From vars. */
  SNAPSHOT_INTERVAL_MINUTES?: string;

  /** Days of backups to retain before pruning older ones from R2. Default 3. From vars. */
  BACKUP_RETENTION_DAYS?: string;

  /**
   * Your account's workers.dev subdomain (the `<sub>` in
   * `https://<worker>.<sub>.workers.dev`). The Worker composes its own public
   * URL as `https://${AGENT_NAME}.${WORKERS_SUBDOMAIN}.workers.dev` to hand to
   * the container's cloudflare_sandbox backend — so a clone needs no per-agent
   * URL. Default lives in wrangler.jsonc; an account constant, not per-agent.
   */
  WORKERS_SUBDOMAIN?: string;

  /**
   * Optional override for the Worker's public URL (e.g. a custom domain). When
   * set, used verbatim instead of the AGENT_NAME + WORKERS_SUBDOMAIN
   * composition. The container's cloudflare_sandbox backend POSTs commands
   * back to /api/sandbox/exec at this URL.
   */
  WORKER_PUBLIC_URL?: string;
}
