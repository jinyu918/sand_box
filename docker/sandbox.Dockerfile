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

RUN npm install -g --no-audit --no-fund \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
    "@deepseek-ai/dsh@${DSH_VERSION}" \
  && npm cache clean --force

RUN useradd --create-home --uid 1000 --shell /bin/bash agent \
  && mkdir -p /home/agent/.dsh /home/agent/.npm /home/agent/.config \
  && chown -R agent:agent /home/agent

COPY docker/entrypoint.sh /usr/local/bin/cove-entrypoint
RUN chmod 0755 /usr/local/bin/cove-entrypoint

USER agent
ENV HOME=/home/agent \
    DSH_HOME=/home/agent/.dsh \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
RUN DSH_HOME=/home/agent/.dsh dsh web --help >/dev/null 2>&1 || true

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/cove-entrypoint"]
CMD ["bash"]
