import type { Sandbox } from "@cloudflare/sandbox";

export interface Env {
  // The Sandbox Durable Object namespace, bound in wrangler.jsonc.
  HermesSandbox: DurableObjectNamespace<Sandbox>;

  // R2 bucket mounted into the container at /opt/data. Hermes' state
  // (sessions, memories, skills, .env, config.yaml) lives directly here.
  DATA_BUCKET: R2Bucket;

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
}
