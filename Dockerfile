# =============================================================================
# Hermes Agent on Cloudflare Sandbox
# =============================================================================
# Base: cloudflare/sandbox lean variant (Ubuntu 22.04 + Node 20, no Python).
# We add Python 3 ourselves below. The image tag MUST match the npm package
# version of @cloudflare/sandbox in package.json — the SDK and base image
# are versioned together.
# See: https://developers.cloudflare.com/sandbox/configuration/dockerfile/
# =============================================================================
FROM docker.io/cloudflare/sandbox:0.7.20

# The 0.7.20 base is the lean variant (Node 20, no Python). Install Python
# 3 so Hermes' install.sh (which uses uv + pip) works. start-hermes.sh
# itself uses plain bash + heredoc to write config — no Python lib deps.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Hermes requires Node 22; the base ships Node 20. Replace it.
ENV NODE_VERSION=22.22.1
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported arch: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && apt-get update && apt-get install -y --no-install-recommends xz-utils ca-certificates \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && curl -fsSLk "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version && npm --version

# `uv` — Astral's Python package manager that Hermes' install.sh uses.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv --version

# Run Hermes as a non-root user with home under /home — the Sandbox SDK's
# backup API only allows /home, /workspace, /tmp, /var/tmp.
RUN useradd --create-home --shell /bin/bash --uid 1000 hermes
ENV HOME=/home/hermes
ENV HERMES_HOME=/home/hermes/.hermes

# Pre-create the data directory and symlink Hermes' conventional /opt/data
# path to it. /opt/data is the path Hermes' Docker docs document; we keep
# the symlink for any tools that hard-code it. The real data lives in
# /home/hermes/.hermes so the Sandbox SDK can include it in snapshots.
RUN mkdir -p /home/hermes/.hermes \
    && ln -s /home/hermes/.hermes /opt/data \
    && chown -R hermes:hermes /home/hermes

# Install Hermes Agent.
# `install.sh` clones NousResearch/hermes-agent and pip-installs it.
# --skip-setup avoids the interactive wizard (we configure via env at runtime).
# --no-venv keeps deps in the system Python — simpler for a single-tenant image.
USER hermes
WORKDIR /home/hermes
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
      | bash -s -- --skip-setup --hermes-home /home/hermes/.hermes \
    && ls -la /home/hermes/.hermes/hermes-agent

# Add hermes' user bin to PATH so the `hermes` CLI is reachable.
ENV PATH=/home/hermes/.local/bin:/home/hermes/.hermes/node/bin:$PATH

# Snapshot-friendly permissions: mksquashfs (used by createBackup) needs
# everything readable.
RUN chmod -R a+rX /home/hermes

# Startup script — writes config from env vars, then `hermes gateway run`.
USER root
COPY start-hermes.sh /usr/local/bin/start-hermes.sh
RUN chmod +x /usr/local/bin/start-hermes.sh
USER hermes

# Hermes gateway listens here. Started by the Worker via startProcess(),
# not by a Dockerfile CMD — that way we get stdout/stderr capture.
EXPOSE 8642
