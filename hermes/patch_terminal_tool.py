"""Patch Hermes' tools/terminal_tool.py to register the `cloudflare_sandbox` backend.

Hermes' `_create_environment()` and `check_terminal_requirements()` are
hardcoded if/elif over env_type with no plugin hook. We inject two
`elif env_type == "cloudflare_sandbox"` branches by string-replace.

Run once at Docker build time (see Dockerfile).
"""
import sys

PATH = "/opt/hermes-install/hermes-agent/tools/terminal_tool.py"

with open(PATH) as f:
    src = f.read()

# ---- 1. _create_environment: route to CloudflareSandboxEnvironment ----
# Anchor on the two-line `ssh` branch in _create_environment (a single-line
# marker matches twice — the other "ssh" branch is in _get_terminal_config
# where it only sets default_cwd).
create_marker = '    elif env_type == "ssh":\n        if not ssh_config'
create_patch = (
    '    elif env_type == "cloudflare_sandbox":\n'
    '        from tools.environments.cloudflare_sandbox import '
    'CloudflareSandboxEnvironment as _CloudflareSandboxEnvironment\n'
    '        return _CloudflareSandboxEnvironment(cwd=cwd, timeout=timeout, task_id=task_id)\n\n'
)
if create_marker not in src:
    sys.exit("ERR: _create_environment ssh-branch marker not found")
if "cloudflare_sandbox" not in src:
    src = src.replace(create_marker, create_patch + create_marker, 1)

# ---- 2. check_terminal_requirements: don't reject our env_type ----
# Anchor on the `Unknown TERMINAL_ENV` else branch — insert our elif before it.
req_marker = (
    '        else:\n'
    '            logger.error(\n'
    '                "Unknown TERMINAL_ENV'
)
req_patch = (
    '        elif env_type == "cloudflare_sandbox":\n'
    '            import os\n'
    '            if not os.getenv("CLOUDFLARE_WORKER_URL") or not os.getenv("HERMES_GATEWAY_TOKEN"):\n'
    '                logger.error("cloudflare_sandbox backend requires CLOUDFLARE_WORKER_URL + HERMES_GATEWAY_TOKEN env vars")\n'
    '                return False\n'
    '            return True\n\n'
)
if req_marker not in src:
    sys.exit("ERR: check_terminal_requirements else-branch marker not found")
if 'env_type == "cloudflare_sandbox"' not in src.split("check_terminal_requirements")[-1]:
    src = src.replace(req_marker, req_patch + req_marker, 1)

with open(PATH, "w") as f:
    f.write(src)
print("patched terminal_tool.py (cloudflare_sandbox added to _create_environment + check_terminal_requirements)")
