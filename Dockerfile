FROM ubuntu:24.04
ARG TARGETARCH

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

# ── Browser ───────────────────────────────────────────────────────────────────
# Google Chrome does not publish arm64 Linux packages.  On arm64 we install
# Chromium from the Debian Bookworm archive instead (Ubuntu 24.04 ships
# Chromium as a snap only, which cannot run inside a Docker container).
# A symlink makes /usr/bin/google-chrome-stable resolve on both architectures
# so the CHROME_BIN env-var works unchanged.
RUN if [ "${TARGETARCH}" = "arm64" ]; then \
      curl -fsSL https://ftp-master.debian.org/keys/archive-key-12.asc \
        | gpg --dearmor -o /usr/share/keyrings/debian-bookworm-archive-keyring.gpg \
      && printf 'deb [arch=arm64 signed-by=/usr/share/keyrings/debian-bookworm-archive-keyring.gpg] http://deb.debian.org/debian bookworm main\n' \
          > /etc/apt/sources.list.d/debian-bookworm.list \
      && printf 'Package: chromium*\nPin: release n=bookworm\nPin-Priority: 1001\n' \
          > /etc/apt/preferences.d/chromium-bookworm \
      && apt-get update \
      && apt-get install -y --no-install-recommends chromium \
      && rm /etc/apt/sources.list.d/debian-bookworm.list \
      && rm /usr/share/keyrings/debian-bookworm-archive-keyring.gpg \
      && rm /etc/apt/preferences.d/chromium-bookworm \
      && apt-get update \
      && ln -sf /usr/bin/chromium /usr/bin/google-chrome-stable; \
    else \
      curl -fsSL -o /tmp/google-chrome-stable.deb \
           https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
      && dpkg -i /tmp/google-chrome-stable.deb; apt-get install -f -y \
      && rm /tmp/google-chrome-stable.deb; \
    fi

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
