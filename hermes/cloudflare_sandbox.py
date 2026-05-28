"""Cloudflare Sandbox execution environment for Hermes Agent.

Routes commands out of the long-lived HermesSandbox container, back through
the parent Worker (POST /api/sandbox/exec), and into a separate ExecSandbox
container managed by the same Worker. The Worker's Sandbox SDK actually
spawns the command — this plugin is just an HTTP shim that adapts the JSON
response to Hermes' BaseEnvironment.ProcessHandle protocol.

Required env vars (passed from the Worker via startProcess() env):
    CLOUDFLARE_WORKER_URL   e.g. https://hermes-cloudflare.<sub>.workers.dev
    HERMES_GATEWAY_TOKEN    same token gating /api/*

The plugin is registered by patching tools/terminal_tool.py at Docker build
time (see Dockerfile sed step), since Hermes' _create_environment() has no
runtime registry hook for new backends.
"""

import json
import logging
import os
import urllib.error
import urllib.request

from tools.environments.base import BaseEnvironment, _ThreadedProcessHandle

logger = logging.getLogger(__name__)


class CloudflareSandboxEnvironment(BaseEnvironment):
    """Run commands in a Cloudflare ExecSandbox container via the Worker."""

    # ExecSandbox executes a single command per call — no persistent shell —
    # so we don't need stdin pipes, but heredoc is the only way to deliver
    # multi-line stdin alongside the command in our JSON envelope.
    _stdin_mode = "heredoc"

    def __init__(
        self,
        cwd: str = "/workspace",
        timeout: int = 120,
        task_id: str = "default",
    ):
        super().__init__(cwd=cwd, timeout=timeout)

        worker_url = os.getenv("CLOUDFLARE_WORKER_URL", "").rstrip("/")
        token = os.getenv("HERMES_GATEWAY_TOKEN", "")
        if not worker_url:
            raise ValueError(
                "CLOUDFLARE_WORKER_URL must be set for the cloudflare_sandbox backend"
            )
        if not token:
            raise ValueError(
                "HERMES_GATEWAY_TOKEN must be set for the cloudflare_sandbox backend"
            )
        self._worker_url = worker_url
        self._token = token
        self._task_id = task_id
        self._exec_url = f"{self._worker_url}/api/sandbox/exec?token={self._token}"

        logger.info(
            "CloudflareSandbox: worker=%s task_id=%s cwd=%s",
            self._worker_url,
            task_id,
            self.cwd,
        )
        self.init_session()

    def _run_bash(
        self,
        cmd_string: str,
        *,
        login: bool = False,
        timeout: int = 120,
        stdin_data: str | None = None,
    ):
        # The Worker's /api/sandbox/exec wraps the command in `bash -c` already
        # (via sandbox.exec()), but Hermes' wrappers (snapshot sourcing, CWD
        # markers) assume bash semantics. Pass the wrapped script as one bash
        # invocation. login flag (`bash -l`) only fires during init_session
        # when no snapshot is ready yet.
        import shlex

        if login:
            shell_cmd = f"bash -l -c {shlex.quote(cmd_string)}"
        else:
            shell_cmd = f"bash -c {shlex.quote(cmd_string)}"

        url = self._exec_url
        # Worker expects timeout_ms; add a small margin so the Worker times out
        # before we do (we want its structured error, not a urllib socket abort).
        payload = json.dumps(
            {
                "command": shell_cmd,
                "timeout_ms": int(timeout) * 1000,
            }
        ).encode("utf-8")

        def exec_fn() -> tuple[str, int]:
            # User-Agent header is required: Cloudflare's edge WAF rejects
            # urllib's default ("Python-urllib/3.11") with error 1010.
            req = urllib.request.Request(
                url,
                data=payload,
                headers={
                    "content-type": "application/json",
                    "user-agent": "hermes-cloudflare-plugin/1.0",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout + 30) as resp:
                    data = json.loads(resp.read().decode("utf-8", errors="replace"))
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")
                return (f"[cloudflare_sandbox HTTP {exc.code}] {body}", 1)
            except Exception as exc:
                return (f"[cloudflare_sandbox transport error] {exc}", 1)

            stdout = data.get("stdout") or ""
            stderr = data.get("stderr") or ""
            exit_code = data.get("exit_code")
            if not isinstance(exit_code, int):
                exit_code = 0 if data.get("success") else 1
            output = stdout if not stderr else (stdout + ("\n" if stdout else "") + stderr)
            return (output, exit_code)

        # No cancellation API on the Worker side yet. kill() is a no-op; the
        # base class still enforces wall-clock timeout on its end.
        return _ThreadedProcessHandle(exec_fn, cancel_fn=None)

    def cleanup(self):
        # The Worker owns ExecSandbox lifecycle (single shared instance for
        # Stage 1). Nothing to release from the client side.
        pass
