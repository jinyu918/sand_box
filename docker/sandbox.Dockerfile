FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.310
ARG CODEX_VERSION=0.164.0
ARG DSH_VERSION=0.2.1-rc.2
ARG APT_MIRROR=deb.debian.org

RUN if [ "$APT_MIRROR" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
      sed -i "s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    hostname \
    iproute2 \
    jq \
    less \
    procps \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN NODE_OPTIONS=--dns-result-order=ipv4first npm install -g --no-audit --no-fund \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
    "@deepseek-ai/dsh@${DSH_VERSION}" \
  && npm cache clean --force

RUN base=/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules \
  && mkdir -p "$base/node-addon-require-builtin/build/napi/napi-v9-linux-x64-gnu" \
  && cp "$base/node-addon-require-builtin-linux-x64-gnu/prebuilt/linux-x64-gnu-napi-v9.node" \
        "$base/node-addon-require-builtin/build/napi/napi-v9-linux-x64-gnu/require_builtin.node"

RUN mkdir -p /home/agent/.dsh /home/agent/.npm /home/agent/.config /home/agent/.tmp /home/agent/.cache \
  && chown -R 1000:1000 /home/agent

COPY docker/entrypoint.sh /usr/local/bin/cove-entrypoint
RUN chmod 0755 /usr/local/bin/cove-entrypoint

USER 1000:1000
ENV HOME=/home/agent \
    DSH_HOME=/home/agent/.dsh \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
RUN DSH_HOME=/home/agent/.dsh dsh web --help >/dev/null 2>&1 || true

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/cove-entrypoint"]
CMD ["bash"]
