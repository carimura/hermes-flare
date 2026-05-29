# =============================================================================
# Hermes Agent on Cloudflare Sandbox
# =============================================================================
# Base: cloudflare/sandbox lean variant (Ubuntu 22.04 + Node 20, no Python).
# We add Python 3 ourselves below.
#
# IMPORTANT: the image tag MUST match `@cloudflare/sandbox` in package.json
# (and in Dockerfile.exec). The SDK and base image are released together;
# version drift across them causes runtime API mismatches.
# See: https://developers.cloudflare.com/sandbox/configuration/dockerfile/
# =============================================================================
FROM docker.io/cloudflare/sandbox:0.7.21

# The 0.7.20 base is the lean variant (Node 20, no Python). Install Python
# 3 so Hermes' install.sh (which uses uv + pip) works. start-hermes.sh
# itself uses plain bash + heredoc to write config — no Python lib deps.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Hermes requires Node 22; the base ships Node 20. Replace it.
# We fetch SHASUMS256.txt alongside the tarball and verify before extracting
# (mirrors the official node:22 Dockerfile). The previous version used
# `curl -fsSLk` which silently disabled TLS verification — gone now.
ENV NODE_VERSION=22.22.1
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported arch: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    && apt-get update && apt-get install -y --no-install-recommends xz-utils ca-certificates \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && cd /tmp \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o SHASUMS256.txt \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}" -o "${NODE_TARBALL}" \
    && grep " ${NODE_TARBALL}\$" SHASUMS256.txt | sha256sum -c - \
    && tar -xJf "${NODE_TARBALL}" -C /usr/local --strip-components=1 \
    && rm "${NODE_TARBALL}" SHASUMS256.txt \
    && node --version && npm --version

# `uv` — Astral's Python package manager that Hermes' install.sh uses.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv --version

# Hermes-as-user during install (so symlinks/files end up owned by hermes).
# Container runs as root at runtime for the Sandbox SDK's mksquashfs.
RUN useradd --create-home --shell /bin/bash --uid 1000 hermes
ENV HOME=/home/hermes

# Hermes install vs. user-state data are kept SEPARATE so snapshots stay
# small. The install (~1.5 GB Python venv + Node 22 bundle) lives under
# /opt/hermes-install — outside the snapshot backup tree. The runtime data
# dir (`HERMES_HOME=/home/hermes/.hermes`) holds only user state: sessions,
# memories, skills, .env, config.yaml, logs.
ENV HERMES_HOME=/home/hermes/.hermes
RUN mkdir -p /opt/hermes-install /home/hermes/.hermes \
    && chown -R hermes:hermes /opt/hermes-install /home/hermes

# Install Hermes Agent at /opt/hermes-install. install.sh creates
# /opt/hermes-install/hermes-agent (the Python code + venv) and
# /opt/hermes-install/node (the Node 22 bundle). User-level symlinks at
# /home/hermes/.local/bin still point at the absolute install paths, so the
# `hermes` CLI keeps working when HERMES_HOME differs from install location.
USER hermes
WORKDIR /home/hermes
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
      | bash -s -- --skip-setup --hermes-home /opt/hermes-install \
    && ls -la /opt/hermes-install/hermes-agent \
    # Strip install-time caches — uv defaults to $HOME/.cache/uv which is
    # several hundred MB of wheels we don't need at runtime. Without this,
    # /home/hermes (the snapshot tree) balloons even though the install
    # itself is at /opt/hermes-install.
    && rm -rf /home/hermes/.cache /home/hermes/.npm

ENV PATH=/home/hermes/.local/bin:/opt/hermes-install/node/bin:$PATH

# ---- Custom terminal backend: cloudflare_sandbox ----
# Routes Hermes-issued shell commands out to a separate Exec container
# via the parent Worker. The plugin file lives alongside the other backends.
# terminal_tool.py's _create_environment() is hardcoded if/elif over env_type,
# so we patch it with sed to add an `elif env_type == "cloudflare_sandbox"`
# branch right before the existing "ssh" branch.
COPY --chown=hermes:hermes hermes/cloudflare_sandbox.py \
     /opt/hermes-install/hermes-agent/tools/environments/cloudflare_sandbox.py
COPY --chown=hermes:hermes hermes/patch_terminal_tool.py /tmp/patch_terminal_tool.py
RUN python3 /tmp/patch_terminal_tool.py && rm /tmp/patch_terminal_tool.py

# Snapshot-friendly permissions: mksquashfs (used by createBackup) needs
# everything readable. /home/hermes is small now (install is at /opt).
RUN chmod -R a+rX /home/hermes

# Startup script — writes config from env vars, then `hermes gateway run`.
# Container ends as root (no final `USER hermes`) so the Sandbox SDK can
# run mksquashfs for snapshot/backup. Hermes accepts running as root when
# HERMES_ALLOW_ROOT_GATEWAY=1 is set (see Worker envVars).
USER root
COPY start-hermes.sh /usr/local/bin/start-hermes.sh
RUN chmod +x /usr/local/bin/start-hermes.sh

# Hermes gateway listens here. Started by the Worker via startProcess(),
# not by a Dockerfile CMD — that way we get stdout/stderr capture.
EXPOSE 8642
