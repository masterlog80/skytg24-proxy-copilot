FROM ubuntu:24.04

LABEL maintainer="skytg24-proxy-copilot" \
      description="Sky TG24 live-stream proxy with Windscribe VPN control UI"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    CONTROL_PORT=3000 \
    PROXY_HOST=localhost \
    VPN_CONFIG_DIR=/config/vpn \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROME_BIN=/usr/bin/chromium

# ── System packages ───────────────────────────────────────────────────────────
RUN apt-get update

RUN apt-get install -y --no-install-recommends \
        openvpn \
        curl \
        gnupg \
        ca-certificates \
        iproute2 \
        net-tools \
        dnsutils \
        iptables \
        fonts-liberation \
        libasound2t64 \
        libatk-bridge2.0-0t64 \
        libatk1.0-0t64 \
        libcups2t64 \
        libdbus-1-3 \
        libgdk-pixbuf-2.0-0 \
        libgtk-3-0t64 \
        libnspr4 \
        libnss3 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        xdg-utils

# ── Browser ───────────────────────────────────────────────────────────────────
#RUN apt-get install -y --no-install-recommends chromium-browser
RUN apt-get update && apt-get install -y chromium

# ── Node.js ───────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash -

RUN apt-get install -y --no-install-recommends nodejs

RUN apt-get clean && rm -rf /var/lib/apt/lists/*

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
