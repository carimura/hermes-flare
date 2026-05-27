# =============================================================================
# Hermes Agent on Cloudflare Sandbox
# =============================================================================
# Base: cloudflare/sandbox lean variant (Ubuntu 22.04 + Node 20, no Python).
# We apt-install Python 3 below. The image tag MUST match the @cloudflare/
# sandbox npm package version in package.json — SDK and image are versioned
# together.
# See: https://developers.cloudflare.com/sandbox/configuration/dockerfile/
# =============================================================================
FROM docker.io/cloudflare/sandbox:0.10.2-python

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

# Hermes runs as a non-root user. We split install vs data:
#   - INSTALL stays in /home/hermes/.hermes/hermes-agent (ephemeral but fast;
#     every Python import is a local-disk read, not an R2 GET)
#   - DATA lives at /opt/data, where the Worker mounts the R2 bucket at
#     runtime. start-hermes.sh sets HERMES_HOME=/opt/data so Hermes treats
#     the mount as its state dir.
RUN useradd --create-home --shell /bin/bash --uid 1000 hermes
ENV HOME=/home/hermes

RUN mkdir -p /home/hermes/.hermes /opt/data \
    && chown -R hermes:hermes /home/hermes /opt/data

# Install Hermes Agent.
# `install.sh` clones NousResearch/hermes-agent and pip-installs it.
# --skip-setup avoids the interactive wizard (we configure via env at runtime).
# --hermes-home places the install at /home/hermes/.hermes/hermes-agent; this
# stays on local container disk regardless of the runtime R2 mount.
USER hermes
WORKDIR /home/hermes
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
      | bash -s -- --skip-setup --hermes-home /home/hermes/.hermes \
    && ls -la /home/hermes/.hermes/hermes-agent

# Add hermes' user bin to PATH so the `hermes` CLI is reachable.
ENV PATH=/home/hermes/.local/bin:/home/hermes/.hermes/node/bin:$PATH

RUN chmod -R a+rX /home/hermes

# Startup script — writes config from env vars, then `hermes gateway run`.
USER root
COPY start-hermes.sh /usr/local/bin/start-hermes.sh
RUN chmod +x /usr/local/bin/start-hermes.sh
USER hermes

# Hermes gateway listens here. Started by the Worker via startProcess(),
# not by a Dockerfile CMD — that way we get stdout/stderr capture.
EXPOSE 8642
