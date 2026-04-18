FROM ubuntu:24.04

LABEL maintainer="skytg24-proxy-copilot" \
      description="Sky TG24 live-stream proxy with Windscribe VPN control UI"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    CONTROL_PORT=3000 \
    PROXY_HOST=localhost \
    VPN_CONFIG_DIR=/config/vpn \
    CHROME_BIN=/usr/bin/google-chrome-stable \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

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

# ── Google Chrome ─────────────────────────────────────────────────────────────
# Download the .deb directly; then use apt-get install -f to pull in any
# missing dependencies (e.g. libxss1 removed in Ubuntu 22.04+).
RUN curl -fsSL -o /tmp/google-chrome-stable.deb \
         https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y /tmp/google-chrome-stable.deb \
    && rm /tmp/google-chrome-stable.deb

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
