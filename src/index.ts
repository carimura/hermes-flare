import { Hono } from "hono";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { Env } from "./env";
import { createSnapshot, restoreIfNeeded } from "./persistence";

export { HermesSandbox } from "./sandbox";

const SANDBOX_INSTANCE = "hermes"; // single-instance for now

const app = new Hono<{ Bindings: Env }>();

/** Every /api/* route gates on HERMES_GATEWAY_TOKEN passed as ?token=... */
function requireToken(c: { req: { query: (k: string) => string | undefined }; env: Env }): Response | null {
  if (c.req.query("token") !== c.env.HERMES_GATEWAY_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  return null;
}

// ----------------------------------------------------------------------------
// Liveness — does NOT wake the container, no token required
// ----------------------------------------------------------------------------
app.get("/health", (c) => c.text("ok"));

// ----------------------------------------------------------------------------
// Status — wakes the container, ensures the gateway is running
// ----------------------------------------------------------------------------
app.get("/api/status", async (c) => {
  const denied = requireToken(c);
  if (denied) return denied;
  const sandbox = getSandbox(c.env.HermesSandbox, SANDBOX_INSTANCE);
  await restoreIfNeeded(sandbox, c.env.BACKUP_BUCKET);
  const result = await ensureGateway(sandbox, c.env);
  return c.json(result);
});

// ----------------------------------------------------------------------------
// Logs — dump the gateway startup script's recent output. Token-gated.
// ----------------------------------------------------------------------------
app.get("/api/logs", async (c) => {
  const denied = requireToken(c);
  if (denied) return denied;
  const sandbox = getSandbox(c.env.HermesSandbox, SANDBOX_INSTANCE);
  const procs = await sandbox.listProcesses();
  const lines: string[] = [`--- processes (${procs.length}) ---`];
  for (const p of procs) {
    lines.push(`${p.id}  ${p.status}  ${p.command}`);
  }
  const ports = await sandbox.exec(
    "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo '(no ss/netstat)'",
  );
  lines.push("--- listening ports ---", ports.stdout);
  const config = await sandbox.exec("cat /home/hermes/.hermes/config.yaml 2>&1 || echo '(no config)'");
  lines.push("--- config.yaml ---", config.stdout);
  // Hermes also writes structured logs to ~/.hermes/logs/
  const hermesLogs = await sandbox.exec(
    "ls -t /home/hermes/.hermes/logs/ 2>/dev/null | head -3",
  );
  lines.push("--- ~/.hermes/logs/ (most recent) ---", hermesLogs.stdout);
  const latestHermesLog = await sandbox.exec(
    "tail -n 100 \"$(ls -t /home/hermes/.hermes/logs/*.log 2>/dev/null | head -1)\" 2>&1 || echo '(none)'",
  );
  lines.push("--- latest hermes log (last 100) ---", latestHermesLog.stdout);
  const tail = await sandbox.exec("tail -n 200 /tmp/start-hermes.log 2>&1 || echo '(no log)'");
  lines.push("--- /tmp/start-hermes.log (last 200) ---", tail.stdout);
  return c.text(lines.join("\n"));
});

// Generate the Slack app manifest using Hermes' built-in command.
app.get("/api/slack-manifest", async (c) => {
  const denied = requireToken(c);
  if (denied) return denied;
  const sandbox = getSandbox(c.env.HermesSandbox, SANDBOX_INSTANCE);
  const result = await sandbox.exec("hermes slack manifest 2>&1");
  return c.text(result.stdout, 200, { "content-type": "text/plain" });
});

// Force-kill any running gateway process so the next /api/status (or the
// next cron tick) restarts it fresh. Useful when iterating on config.
app.post("/api/kill", async (c) => {
  const denied = requireToken(c);
  if (denied) return denied;
  const sandbox = getSandbox(c.env.HermesSandbox, SANDBOX_INSTANCE);
  await sandbox.exec(
    "pkill -9 -f 'hermes gateway' 2>/dev/null; pkill -9 -f start-hermes 2>/dev/null; true",
  );
  return c.json({ ok: true });
});

// Snapshot /home/hermes to R2.
app.post("/api/snapshot", async (c) => {
  const denied = requireToken(c);
  if (denied) return denied;
  const sandbox = getSandbox(c.env.HermesSandbox, SANDBOX_INSTANCE);
  const handle = await createSnapshot(sandbox, c.env.BACKUP_BUCKET);
  return c.json({ ok: true, handle });
});

// Slack uses Socket Mode (WebSocket from container to Slack) — no webhook
// ingress needed. We don't proxy anything else either; the container is
// reached only via the explicit /api/* routes above.

export default {
  fetch: app.fetch,

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Cron-driven keepalive: restore from R2 if needed, then make sure the
    // Hermes gateway is running so Slack Socket Mode is connected and any
    // cron-scheduled Hermes tasks have a chance to fire.
    ctx.waitUntil(
      (async () => {
        const sandbox = getSandbox(env.HermesSandbox, SANDBOX_INSTANCE);
        await restoreIfNeeded(sandbox, env.BACKUP_BUCKET);
        await ensureGateway(sandbox, env);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Ensure the Hermes gateway process is running.
 *
 * Detection is by process-list (not port probe) because Hermes uses Slack
 * Socket Mode — it never opens an HTTP listener on 8642. Liveness =
 * "is there a `hermes gateway run` process in 'running' or 'starting' status?"
 */
async function ensureGateway(
  sandbox: Sandbox,
  env: Env,
): Promise<{ container: string; gateway_running: boolean; pid?: string }> {
  // Fast path: a gateway is already (or still) running.
  const existing = await findGatewayProcess(sandbox);
  if (existing) {
    return { container: "running", gateway_running: true, pid: existing.id };
  }

  // Start the gateway via our script, capturing output to a known file so
  // /api/logs can surface it. PYTHONUNBUFFERED=1 prevents Hermes (Python)
  // from buffering its stdout when redirected to a file.
  const envVars: Record<string, string> = {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
    HERMES_GATEWAY_TOKEN: env.HERMES_GATEWAY_TOKEN ?? "",
    PYTHONUNBUFFERED: "1",
  };
  if (env.SLACK_BOT_TOKEN) envVars.SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
  if (env.SLACK_APP_TOKEN) envVars.SLACK_APP_TOKEN = env.SLACK_APP_TOKEN;
  if (env.SLACK_ALLOWED_USERS) envVars.SLACK_ALLOWED_USERS = env.SLACK_ALLOWED_USERS;
  if (env.SLACK_REPLY_IN_THREAD) envVars.SLACK_REPLY_IN_THREAD = env.SLACK_REPLY_IN_THREAD;
  if (env.SLACK_HOME_CHANNEL) envVars.SLACK_HOME_CHANNEL = env.SLACK_HOME_CHANNEL;
  if (env.TELEGRAM_BOT_TOKEN) envVars.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  if (env.DISCORD_BOT_TOKEN) envVars.DISCORD_BOT_TOKEN = env.DISCORD_BOT_TOKEN;

  // Truncate the log between runs so stale output doesn't confuse debugging.
  await sandbox.exec("rm -f /tmp/start-hermes.log; true");

  console.log("[ensureGateway] starting gateway process");
  const proc = await sandbox.startProcess(
    "/usr/local/bin/start-hermes.sh > /tmp/start-hermes.log 2>&1",
    { env: envVars },
  );
  console.log(`[ensureGateway] pid=${proc.id} status=${proc.status}`);
  return { container: "running", gateway_running: true, pid: proc.id };
}

/**
 * Find a currently-running Hermes gateway process (our start script wraps it).
 * Returns the process if running/starting, or null if absent/failed.
 */
async function findGatewayProcess(
  sandbox: Sandbox,
): Promise<{ id: string; status: string; command: string } | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const p of processes) {
      if (p.command.includes("start-hermes.sh") && (p.status === "running" || p.status === "starting")) {
        return p;
      }
    }
  } catch (err) {
    console.error("[findGatewayProcess] listProcesses failed:", err);
  }
  return null;
}

