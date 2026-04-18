FROM ubuntu:22.04

LABEL maintainer="skytg24-proxy-copilot" \
      description="Sky TG24 live-stream proxy with Windscribe VPN control UI"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    CONTROL_PORT=3000 \
    PROXY_HOST=localhost \
    VPN_CONFIG_DIR=/config/vpn

# ── System packages ───────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        openvpn \
        curl \
        ca-certificates \
        iproute2 \
        net-tools \
        dnsutils \
        iptables \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# ── App ───────────────────────────────────────────────────────────────────────
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js          ./
COPY services/          ./services/
COPY public/            ./public/

# Config dir (users mount their .ovpn files here)
RUN mkdir -p /config/vpn

# ── Expose ────────────────────────────────────────────────────────────────────
# 3000  → web UI / control API
# 6443  → HLS stream proxy (default; configurable on UI)
EXPOSE 3000 6443

# ── Health check ─────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:${CONTROL_PORT}/api/vpn/status || exit 1

CMD ["node", "server.js"]
