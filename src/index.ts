import { Hono } from "hono";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { Env } from "./env";
import { createSnapshot, restoreLatest, snapshotIfDue } from "./persistence";

export { Agent, Exec } from "./sandbox";

const SANDBOX_INSTANCE = "hermes"; // single-instance for now
const EXEC_SANDBOX_INSTANCE = "exec";

const app = new Hono<{ Bindings: Env }>();

/** Every /api/* route gates on HERMES_GATEWAY_TOKEN passed as ?token=...
 *
 * Fail-closed on a missing/empty configured token: without this check, an
 * unset secret would compare `undefined === undefined` against a request
 * that omits ?token=, letting anyone in. (#12)
 */
function requireToken(c: { req: { query: (k: string) => string | undefined }; env: Env }): Response | null {
  const expected = c.env.HERMES_GATEWAY_TOKEN;
  if (typeof expected !== "string" || expected.length === 0) {
    return new Response("HERMES_GATEWAY_TOKEN is not configured on this Worker", { status: 503 });
  }
  if (c.req.query("token") !== expected) {
    return new Response("forbidden", { status: 403 });
  }
  return null;
}

app.use("/api/*", async (c, next) => {
  const denied = requireToken(c);
  if (denied) return denied;
  await next();
});

// ----------------------------------------------------------------------------
// Liveness — does NOT wake the container, no token required
// ----------------------------------------------------------------------------
app.get("/health", (c) => c.text("ok"));

// ----------------------------------------------------------------------------
// Status — wakes the container, ensures the gateway is running
// ----------------------------------------------------------------------------
app.get("/api/status", async (c) => {
  const sandbox = getAgentSandbox(c.env);
  const result = await ensureGateway(sandbox, c.env);
  return c.json(result);
});

// ----------------------------------------------------------------------------
// Logs — dump the gateway startup script's recent output. Token-gated.
// ----------------------------------------------------------------------------
app.get("/api/logs", async (c) => {
  const sandbox = getAgentSandbox(c.env);
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
  const sizes = await sandbox.exec("du -sh /home/hermes /home/hermes/.hermes /opt/hermes-install 2>&1");
  lines.push("--- du -sh (snapshot tree vs install tree) ---", sizes.stdout);
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
  const sandbox = getAgentSandbox(c.env);
  const result = await sandbox.exec("hermes slack manifest 2>&1");
  return c.text(result.stdout, 200, { "content-type": "text/plain" });
});

// Force-kill any running gateway process so the next /api/status (or the
// next cron tick) restarts it fresh. Useful when iterating on config.
app.post("/api/kill", async (c) => {
  const sandbox = getAgentSandbox(c.env);
  await sandbox.exec(
    "pkill -9 -f 'hermes gateway' 2>/dev/null; pkill -9 -f start-hermes 2>/dev/null; true",
  );
  return c.json({ ok: true });
});

// Snapshot /home/hermes to R2. Synchronous — `ctx.waitUntil()` was getting
// cancelled within a second on light traffic, so we just block the response
// on mksquashfs. /home/hermes is small (~100MB) since the Hermes install
// lives at /opt/hermes-install, so this typically finishes in a few seconds.
app.post("/api/snapshot", async (c) => {
  const sandbox = getAgentSandbox(c.env);
  const t0 = Date.now();
  try {
    const handle = await createSnapshot(sandbox, c.env.BACKUP_BUCKET, agentName(c.env), backupRetentionDays(c.env));
    return c.json({ ok: true, handle, duration_ms: Date.now() - t0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: message, duration_ms: Date.now() - t0 }, 500);
  }
});

// Run a shell command inside the long-lived Agent container. Token-gated.
// Mirrors `/api/sandbox/exec` for Exec; useful for diagnostics and for
// testing snapshot/restore round-trips.
app.post("/api/hermes/exec", async (c) => {
  let body: { command?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  if (typeof body.command !== "string" || !body.command) {
    return c.json({ error: "missing or invalid 'command' (string)" }, 400);
  }
  const sandbox = getAgentSandbox(c.env);
  const result = await sandbox.exec(body.command);
  return c.json({
    success: result.success,
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });
});

// Force-restore from the latest R2 snapshot. Useful for testing the round-trip
// or after manually corrupting state. The gateway should be killed first
// (POST /api/kill) so the restore doesn't fight live writes.
app.post("/api/restore", async (c) => {
  const sandbox = getAgentSandbox(c.env);
  const t0 = Date.now();
  try {
    const restored = await restoreLatest(sandbox, c.env.BACKUP_BUCKET, agentName(c.env));
    return c.json({ ok: true, restored, duration_ms: Date.now() - t0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: message, duration_ms: Date.now() - t0 }, 500);
  }
});

// ----------------------------------------------------------------------------
// Sandbox exec — run a shell command inside a Hermes-isolated exec container.
// This is the Worker side of the Hermes "cloudflare_sandbox" terminal backend
// (see tools/environments/cloudflare_sandbox.py inside the Hermes container).
//
// Stage 1: single shared Exec instance ("exec"), reused across commands.
// Stage 2 (future): per-command unique-ID sandboxes for full isolation.
// ----------------------------------------------------------------------------
app.post("/api/sandbox/exec", async (c) => {
  let body: { command?: unknown; cwd?: unknown; timeout_ms?: unknown; env?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.command !== "string" || !body.command) {
    return c.json({ error: "missing or invalid 'command' (string)" }, 400);
  }

  const sandbox = getExecSandbox(c.env);
  try {
    const result = await sandbox.exec(body.command, {
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
      timeout: typeof body.timeout_ms === "number" ? body.timeout_ms : 120_000,
      env: (typeof body.env === "object" && body.env)
        ? (body.env as Record<string, string>)
        : undefined,
    });
    return c.json({
      success: result.success,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.duration,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// Slack uses Socket Mode (WebSocket from container to Slack) — no webhook
// ingress needed. We don't proxy anything else either; the container is
// reached only via the explicit /api/* routes above.

export default {
  fetch: app.fetch,

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Cron-driven keepalive: make sure the Hermes gateway is running (which
    // restores from R2 first when the container is fresh) so Slack Socket
    // Mode is connected and any cron-scheduled Hermes tasks can fire.
    ctx.waitUntil(
      (async () => {
        const sandbox = getAgentSandbox(env);
        await ensureGateway(sandbox, env);
        // Keep a fresh backup well ahead of its 72h TTL. Throttled by elapsed
        // time rather than a dedicated cron, so a missed tick just snapshots on
        // the next one. Cadence set by SNAPSHOT_INTERVAL_MINUTES. Wrapped so a
        // snapshot hiccup can't fail the keepalive path.
        try {
          await snapshotIfDue(sandbox, env.BACKUP_BUCKET, agentName(env), snapshotIntervalMs(env), backupRetentionDays(env));
        } catch (err) {
          console.error("[scheduled] snapshot failed:", err);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const DEFAULT_AGENT_NAME = "hermes-flare";

/** This agent's identity — the R2 key namespace (see persistence.ts). One
 *  Worker == one agent. Falls back to the wrangler.jsonc default if unset. */
function agentName(env: Env): string {
  return env.AGENT_NAME && env.AGENT_NAME.length > 0 ? env.AGENT_NAME : DEFAULT_AGENT_NAME;
}

/** This Worker's public URL for the container's terminal backend to call back
 *  to /api/sandbox/exec. Composed from AGENT_NAME + WORKERS_SUBDOMAIN so a clone
 *  needs no per-agent URL; WORKER_PUBLIC_URL overrides (e.g. a custom domain). */
function workerPublicUrl(env: Env): string {
  if (env.WORKER_PUBLIC_URL) return env.WORKER_PUBLIC_URL;
  if (env.WORKERS_SUBDOMAIN) return `https://${agentName(env)}.${env.WORKERS_SUBDOMAIN}.workers.dev`;
  return "";
}

type SandboxHandleOptions = {
  keepAlive?: boolean;
  sleepAfter?: string;
  transport?: "rpc";
};

const FORWARDED_OPTIONAL_ENV_KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_ALLOWED_USERS",
  "SLACK_REPLY_IN_THREAD",
  "SLACK_HOME_CHANNEL",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
] as const;

function getSandboxOptions(env: Env): SandboxHandleOptions {
  // transport "rpc": the default "http" transport buffers an entire backup
  // archive (plus a base64 copy) in the DO isolate on restoreBackup, which
  // blows the 128MB memory limit on our ~150MB /home/hermes snapshots. The
  // rpc control path streams it into the container instead.
  return env.SANDBOX_SLEEP_AFTER && env.SANDBOX_SLEEP_AFTER !== "never"
    ? { sleepAfter: env.SANDBOX_SLEEP_AFTER, transport: "rpc" }
    : { keepAlive: true, transport: "rpc" };
}

function getAgentSandbox(env: Env): Sandbox {
  return getSandbox(env.Agent, SANDBOX_INSTANCE, getSandboxOptions(env));
}

function getExecSandbox(env: Env): Sandbox {
  return getSandbox(env.Exec, EXEC_SANDBOX_INSTANCE, getSandboxOptions(env));
}

const DEFAULT_SNAPSHOT_INTERVAL_MINUTES = 240;

/** Minimum age of the latest backup before the cron takes a fresh snapshot. */
function snapshotIntervalMs(env: Env): number {
  const minutes = Number(env.SNAPSHOT_INTERVAL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SNAPSHOT_INTERVAL_MINUTES) * 60_000;
}

const DEFAULT_BACKUP_RETENTION_DAYS = 3;

/** How many days of backups to keep before pruning older ones. */
function backupRetentionDays(env: Env): number {
  const days = Number(env.BACKUP_RETENTION_DAYS);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_BACKUP_RETENTION_DAYS;
}

function buildGatewayEnv(env: Env): Record<string, string> {
  const envVars: Record<string, string> = {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? "",
    HERMES_GATEWAY_TOKEN: env.HERMES_GATEWAY_TOKEN ?? "",
    // Container runs as root (so mksquashfs can run for snapshots);
    // Hermes refuses to start its gateway as root without this opt-in.
    HERMES_ALLOW_ROOT_GATEWAY: "1",
    PYTHONUNBUFFERED: "1",
  };

  for (const key of FORWARDED_OPTIONAL_ENV_KEYS) {
    const value = env[key];
    if (value) envVars[key] = value;
  }

  // ---- Terminal backend: route Hermes-issued shell commands to Exec ----
  // The cloudflare_sandbox plugin POSTs back to /api/sandbox/exec.
  const workerUrl = workerPublicUrl(env);
  if (workerUrl) {
    envVars.CLOUDFLARE_WORKER_URL = workerUrl;
    envVars.TERMINAL_ENV = "cloudflare_sandbox";
    envVars.TERMINAL_CWD = "/workspace";
  }

  return envVars;
}

/**
 * Ensure the Hermes gateway process is running.
 *
 * Detection is by process-list (not port probe) because Hermes uses Slack
 * Socket Mode — it never opens an HTTP listener on 8642. Liveness =
 * "is there a `hermes gateway run` process in 'running' or 'starting' status?"
 */
/**
 * In-flight gateway-start promise, used as a per-isolate mutex.
 *
 * Without this, /api/status and the scheduled cron handler can both call
 * ensureGateway concurrently: both see no gateway running, both call
 * startProcess, two start-hermes.sh processes race for port 8642 and
 * config.yaml. (#19) Storing the in-flight Promise here serializes
 * concurrent callers within the same isolate; cross-isolate races are
 * still possible but rare and Hermes' own gateway.lock catches them.
 */
let gatewayStartInFlight: Promise<{
  container: string;
  gateway_running: boolean;
  pid?: string;
  restore_error?: string;
}> | null = null;

async function ensureGateway(
  sandbox: Sandbox,
  env: Env,
): Promise<{ container: string; gateway_running: boolean; pid?: string; restore_error?: string }> {
  // Fast path: a gateway is already (or still) running.
  const existing = await findGatewayProcess(sandbox);
  if (existing) {
    return { container: "running", gateway_running: true, pid: existing.id };
  }

  // Slow path: at most one concurrent start per isolate.
  if (gatewayStartInFlight) {
    return gatewayStartInFlight;
  }

  gatewayStartInFlight = (async () => {
    try {
      // Re-check inside the lock: a concurrent caller may have already
      // started one between the outer fast-path check and our acquiring
      // the lock here.
      const recheck = await findGatewayProcess(sandbox);
      if (recheck) {
        return { container: "running", gateway_running: true, pid: recheck.id };
      }

      // No gateway means a fresh container (processes don't survive
      // restarts) or a deliberate /api/kill — both want the latest snapshot
      // back before starting. This is the ONLY place restores happen: a
      // running gateway's state is live and must never be restored over.
      // A failed restore must not keep the gateway down — surface it in the
      // result instead.
      let restoreError: string | undefined;
      try {
        await restoreLatest(sandbox, env.BACKUP_BUCKET, agentName(env));
      } catch (err) {
        restoreError = err instanceof Error ? err.message : String(err);
        console.error("[ensureGateway] restore failed (continuing):", err);
      }

      // Start the gateway via our script, capturing output to a known
      // file so /api/logs can surface it. PYTHONUNBUFFERED=1 prevents
      // Hermes (Python) from buffering its stdout when redirected.
      const envVars = buildGatewayEnv(env);

      // Truncate the log between runs so stale output doesn't confuse debugging.
      await sandbox.exec("rm -f /tmp/start-hermes.log; true");

      console.log("[ensureGateway] starting gateway process");
      const proc = await sandbox.startProcess(
        "/usr/local/bin/start-hermes.sh > /tmp/start-hermes.log 2>&1",
        { env: envVars },
      );
      console.log(`[ensureGateway] pid=${proc.id} status=${proc.status}`);
      return {
        container: "running",
        gateway_running: true,
        pid: proc.id,
        ...(restoreError ? { restore_error: restoreError } : {}),
      };
    } finally {
      gatewayStartInFlight = null;
    }
  })();

  return gatewayStartInFlight;
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
