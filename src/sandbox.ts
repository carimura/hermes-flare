import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";

/**
 * The container Hermes runs inside. Long-lived; one instance ("hermes")
 * that survives across requests via DO storage + (eventually) R2 snapshots.
 */
export class HermesSandbox extends BaseSandbox {}

/**
 * The exec sandbox where Hermes-issued shell commands run. Isolated from
 * the Hermes container so the agent can write/run/break code without
 * touching Hermes' filesystem.
 *
 * Stage 1: single shared instance ("exec"), reused across all commands.
 * Stage 2 (future): per-command unique-ID instances for full isolation
 * between commands. The same class works for both — only the routing in
 * /api/sandbox/exec changes.
 */
export class ExecSandbox extends BaseSandbox {}
