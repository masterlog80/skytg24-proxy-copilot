# skytg24-proxy-copilot

A Docker image that provides a **modern dark-themed web UI** to:

1. **Connect / Disconnect** to [Windscribe VPN](https://windscribe.com) via OpenVPN (any endpoint, e.g. *Milan Duomo*, *Milan Galleria*)
2. **Auto-detect** the Sky TG24 live-stream HLS URL from [tg24.sky.it/diretta](https://tg24.sky.it/diretta) using a headless browser
3. **Proxy the HLS stream** locally on a configurable port (default **6443**) so any local player (VLC, browser, ffplay) can watch it
4. **Show live stats**: VPN status, connected clients, detected stream URL, stream resolution & frame-rate, and a real-time upload/download traffic graph over the VPN
5. **Persist settings** to `./config/settings.json` so the form is pre-filled after a container restart

---

## Screenshot

### Control panel — idle state

![Sky TG24 VPN Proxy – control panel](https://github.com/user-attachments/assets/659f710f-3460-4deb-aa55-1d14541be499)

> The panel is split into two columns:
> **Left** — VPN Control card + Stream Control card  
> **Right** — Live status chips (VPN status, stream active/inactive, connected clients, resolution, frame-rate), VPN traffic graph, detected HLS URL box, and an event log

---

## Requirements

| Requirement | Notes |
|---|---|
| Docker ≥ 20.10 | With `docker compose` plugin |
| `/dev/net/tun` | Present on most Linux hosts; not available on Docker Desktop for Mac/Windows without extra config |
| Windscribe account | Free tier is sufficient; you need your **OpenVPN credentials** and one or more `.ovpn` config files |

---

## UI overview

The control panel at **http://localhost:3080** is divided into two columns.

### Left column

| Card | Controls |
|---|---|
| **🛡 VPN Control** | Endpoint dropdown (populated from `.ovpn` files), OpenVPN username & password, **⚡ Connect** / **✖ Disconnect** buttons, status message bar |
| **📡 Stream Control** | HLS URL field with **↺ auto-fetch** button, Fallback URL field, Proxy Port input (default `6443`), **▶ Start** / **◼ Stop** buttons, *Local stream URL* box (shown only while streaming, with one-click copy) |

### Right column

| Widget | What it shows |
|---|---|
| **Status chips** | VPN status + tunnel IP · Stream active/inactive + port · Connected clients · Detected resolution (e.g. `1920x1080`) · Frame-rate (e.g. `25 fps`) |
| **📊 VPN Traffic** | Real-time 60-second upload (▲ green) and download (▼ blue) rate graph over the VPN tunnel |
| **🔗 Detected Live Stream URL** | The last HLS URL found by the auto-detect headless browser scrape |
| **🖥 Event Log** | Colour-coded timestamped log of all UI actions and state changes (blue = info, green = ok, yellow = warn, red = error) |

---

## Quick start

### 1 — Get your Windscribe OpenVPN config files

1. Log in at **https://windscribe.com**
2. Go to **My Account → OpenVPN Config Generator**
   (direct link: <https://windscribe.com/getconfig/openvpn>)
3. Select **Protocol: UDP**, **Port: 443**, and the **Location** you want (e.g. Italy → Milan Duomo)
4. Click **Download** – you get a `.ovpn` file

Repeat for each endpoint you want to use.

> **Tip – naming**: the UI derives the dropdown label from the filename.
> `milan-duomo.ovpn` → **Milan Duomo** | `milan-galleria.ovpn` → **Milan Galleria**

### 2 — Place the configs and start the container

```bash
git clone https://github.com/masterlog80/skytg24-proxy-copilot.git
cd skytg24-proxy-copilot

# Build the image
docker build -t skytg24-proxy-copilot .

# Copy your .ovpn files into config/vpn/
cp ~/milan-duomo.ovpn     config/vpn/
cp ~/milan-galleria.ovpn  config/vpn/

# (Optional) restore a previous settings file
# cp ~/settings.json config/

# Start
docker compose -f docker-compose.yml up -d --remove-orphans
```

Open **http://localhost:3080** in your browser.

### 3 — Connect to VPN

1. Select your endpoint from the **Windscribe Endpoint** dropdown
2. Enter your **OpenVPN Username** and **OpenVPN Password**
   *(these are your Windscribe OpenVPN credentials – find them at windscribe.com/getconfig)*
3. Click **⚡ Connect**
4. Wait 5–30 s – the **VPN Status** chip turns **green** and shows the tunnel IP when connected

### 4 — Start the stream

1. Click **↺** next to *Live Stream URL* — a headless Chrome browser loads `tg24.sky.it/diretta`, intercepts the first `.m3u8` network request, and fills in the URL automatically
   - If detection fails (VPN not yet connected, or Sky changed the page) you can paste a known `.m3u8` URL manually or pre-fill the **Fallback URL** field
2. Optionally change the **Proxy Port** (default `6443`)
3. Click **▶ Start** — the HLS reverse proxy starts; the *Local stream URL* box appears with a copy button
4. Open the stream in any HLS-capable player:

```bash
# VLC
vlc http://localhost:6443/stream

# ffplay
ffplay http://localhost:6443/stream
```

Or open `http://localhost:6443/stream` in a browser with an HLS extension.

The **Resolution** and **Frame-rate** chips update automatically once the proxy has fetched the master playlist.

### 5 — Stop / Disconnect

- Click **◼ Stop** to stop the stream proxy (VPN stays connected)
- Click **✖ Disconnect** to stop both stream and VPN

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CONTROL_PORT` | `3000` | Port of the web UI / control API |
| `PROXY_HOST` | `localhost` | Hostname inserted into rewritten HLS playlist URLs – set to your Docker host IP when clients are on a different machine |
| `VPN_CONFIG_DIR` | `/config/vpn` | Directory where `.ovpn` files are read from |
| `SETTINGS_FILE` | `/config/settings.json` | Path where UI settings are persisted |

Example with a different host IP and custom ports:

```yaml
# docker-compose.yml override
environment:
  - CONTROL_PORT=8080
  - PROXY_HOST=192.168.1.100
ports:
  - "8080:8080"
  - "9000:9000"
```

---

## Accessing the stream from another device on your LAN

Set `PROXY_HOST` to the IP address of the machine running Docker:

```bash
PROXY_HOST=192.168.1.50 docker compose up -d
```

Then on any device:

```
http://192.168.1.50:6443/stream
```

---

## Architecture

```
Browser ─── Control Panel (port 3080→3000) ──┬── VPN Manager
                                              │     └── openvpn process (tun0)
                                              │
Player  ─── HLS Proxy  (port 6443) ───────────┴── Stream Manager
                                                    ├── headless Chrome → fetches .m3u8 URL
                                                    ├── rewrites + proxies all HLS playlist URLs
                                                    └── polls master.m3u8 for resolution / fps
```

- **Control server** (Node.js / Express + WebSocket): serves the UI, exposes REST API, pushes live state every second over WebSocket
- **VPN manager**: spawns `openvpn`, watches its log file, emits `connected`/`disconnected` events; automatically stops the stream when the VPN drops
- **Stream manager**: launches a headless Chromium instance to load `tg24.sky.it/diretta` and intercepts the first `.m3u8` network request; then runs a lightweight HLS reverse proxy with allowlisted CDN targets (akamaized.net, skycdn.it, etc.) to prevent SSRF
- **Stats monitor**: reads `/proc/net/dev` every second to compute upload/download byte rates for the `tun0` interface

---

## Settings persistence

UI settings (selected VPN endpoint, username, stream port, stream URL, fallback URL) are automatically saved to `./config/settings.json` on the host whenever a field changes.  On the next page load the form is pre-filled from this file, so you do not have to re-enter your configuration after a container restart.

> **Note**: The VPN **password** is intentionally **not** persisted for security reasons.

The settings file is created automatically the first time a value is changed.  It is stored in the same `./config/` directory as your `.ovpn` files, so the same volume mount covers both.

---

## Docker details

```bash
# Build only
docker build -t skytg24-proxy .

# Run manually (with required capabilities)
docker run -d \
  --name skytg24-proxy \
  --cap-add NET_ADMIN \
  --device /dev/net/tun \
  -p 3000:3000 \
  -p 6443:6443 \
  -v "$(pwd)/config:/config" \
  skytg24-proxy
```

> **⚠️ Security note**: `NET_ADMIN` is required for OpenVPN to create the TUN interface. Do **not** expose the control panel (port 3000) to the public internet without authentication.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| *No .ovpn files found* | Place `.ovpn` files in `./config/vpn/` and restart the container |
| *Authentication failed* | Double-check your Windscribe OpenVPN credentials at windscribe.com/getconfig |
| *Stream URL not found* | Make sure the VPN is connected to an Italian server, then click ↺ again; or paste the `.m3u8` URL manually |
| *Headless browser times out* | The Sky TG24 page structure may have changed; paste a known `.m3u8` URL in the Fallback URL field |
| *Connection timeout* | Try a different endpoint or switch protocol (TCP instead of UDP) in the `.ovpn` file |
| `/dev/net/tun` not found | Run `sudo modprobe tun` on the host, or enable TUN in your VPS provider's control panel |
| Port 6443 already in use | Change the proxy port in the UI before clicking ▶ Start |

---

## Development

```bash
npm install
node server.js      # starts on port 3000
```

No build step – the frontend is plain HTML/CSS/JS with Chart.js bundled in `public/chart.umd.min.js`.

---
