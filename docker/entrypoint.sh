#!/bin/sh
set -eu

mkdir -p "$HOME/.tmp" "$HOME/.cache"

if [ -f /cove/config/codex-config.toml ]; then
  mkdir -p "$HOME/.codex"
  cp /cove/config/codex-config.toml "$HOME/.codex/config.toml"
  chmod 600 "$HOME/.codex/config.toml"
fi

if [ -f /cove/config/dsh-cordis.patch.yml ]; then
  mkdir -p "$DSH_HOME/profiles/web"
  cp /cove/config/dsh-cordis.patch.yml "$DSH_HOME/profiles/web/cordis.patch.yml"
fi

if [ "${COVE_AGENT:-}" = "dsh" ]; then
  host_ip="$(hostname -i | awk '{print $1}')"
  exec dsh web \
    --host "$host_ip" \
    --port "${COVE_DSH_PORT:?missing COVE_DSH_PORT}" \
    --no-open \
    --public-url "${COVE_DSH_PUBLIC_URL:?missing COVE_DSH_PUBLIC_URL}" \
    --trusted-host "${COVE_DSH_TRUSTED_HOST:?missing COVE_DSH_TRUSTED_HOST}"
fi

exec "$@"
