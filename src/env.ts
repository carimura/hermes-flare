import type { Sandbox } from "@cloudflare/sandbox";

export const REQUIRED_GATEWAY_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "HERMES_GATEWAY_TOKEN",
] as const;

export const OPTIONAL_GATEWAY_ENV_KEYS = [
  "OPENAI_API_KEY",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_ALLOWED_USERS",
  "SLACK_REPLY_IN_THREAD",
  "SLACK_HOME_CHANNEL",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
] as const;

export type RequiredGatewayEnvKey = typeof REQUIRED_GATEWAY_ENV_KEYS[number];
export type OptionalGatewayEnvKey = typeof OPTIONAL_GATEWAY_ENV_KEYS[number];

type RequiredGatewayEnv = Record<RequiredGatewayEnvKey, string>;
type OptionalGatewayEnv = Partial<Record<OptionalGatewayEnvKey, string>>;

export interface Env extends RequiredGatewayEnv, OptionalGatewayEnv {
  // The Sandbox Durable Object namespace, bound in wrangler.jsonc.
  Agent: DurableObjectNamespace<Sandbox>;

  // Isolated sandbox where Hermes-issued shell commands run.
  // Stage 1: single shared instance. Stage 2: per-command instances.
  Exec: DurableObjectNamespace<Sandbox>;

  // R2 bucket where snapshots are stored. @cloudflare/sandbox expects
  // this binding name.
  BACKUP_BUCKET: R2Bucket;

  /**
   * Public URL of THIS Worker, used by the Hermes container's
   * cloudflare_sandbox backend to POST commands back to /api/sandbox/exec.
   * Worker has no built-in self-URL API, so we plumb it through as a var
   * from .env (scripts/deploy.sh).
   */
  WORKER_PUBLIC_URL?: string;
}
