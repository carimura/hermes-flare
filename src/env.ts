import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  // The Sandbox Durable Object namespace, bound in wrangler.jsonc.
  HermesSandbox: DurableObjectNamespace<Sandbox>;

  // Isolated sandbox where Hermes-issued shell commands run.
  // Stage 1: single shared instance. Stage 2: per-command instances.
  ExecSandbox: DurableObjectNamespace<Sandbox>;

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

  /**
   * Public URL of THIS Worker, used by the Hermes container's
   * cloudflare_sandbox backend to POST commands back to /api/sandbox/exec.
   * Worker has no built-in self-URL API, so we plumb it through as a var
   * from .env (scripts/deploy.sh).
   */
  WORKER_PUBLIC_URL?: string;
}
