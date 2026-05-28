import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";

/**
 * The container Hermes runs inside. Long-lived; one instance ("hermes")
 * that survives across requests via DO storage + R2 snapshots.
 */
export class Agent extends BaseSandbox {}

/**
 * The exec sandbox where Hermes-issued shell commands run. Isolated from
 * the Agent container so the agent can write/run/break code without
 * touching its own filesystem.
 *
 * Stage 1: single shared instance ("exec"), reused across all commands.
 * Stage 2 (future): per-command unique-ID instances for full isolation
 * between commands. The same class works for both — only the routing in
 * /api/sandbox/exec changes.
 */
export class Exec extends BaseSandbox {}
