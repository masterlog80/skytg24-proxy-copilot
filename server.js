'use strict';

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const fetch   = require('node-fetch');

const VPNManager      = require('./services/vpnManager');
const StreamManager   = require('./services/streamManager');
const StatsMonitor    = require('./services/statsMonitor');
const SettingsManager = require('./services/settingsManager');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const vpnManager      = new VPNManager();
const streamManager   = new StreamManager(() => vpnManager.getStatus());
const statsMonitor    = new StatsMonitor();
const settingsManager = new SettingsManager();

// ── Server-side event log ─────────────────────────────────────────────────────
// Circular buffer (max 200 entries) shared between VPN and Stream events.
// Entries are pushed to every connected WebSocket client on the next tick so
// that the browser's 🖥 Event Log receives server-side errors in real time.
const SERVER_LOG_MAX = 200;
const serverLog = [];
let   _logSeq   = 0;

function addServerLog(msg, type = 'info') {
  serverLog.push({ id: ++_logSeq, ts: Date.now(), msg, type });
  if (serverLog.length > SERVER_LOG_MAX) serverLog.shift();
  const prefix = type === 'ok' ? '✓' : type === 'warn' ? '⚠' : type === 'err' ? '✗' : 'ℹ';
  console.log(`[eventlog] ${prefix} ${msg}`);
}

// Relay StreamManager log events (CDN errors, proxy start/stop, etc.)
streamManager.on('log', ({ msg, type }) => addServerLog(msg, type));

// Relay meaningful VPN state transitions so the Event Log shows, for example,
// "VPN disconnected" right before a CDN geo-block error.
vpnManager.on('status', (state) => {
  if (state.status === 'connected') {
    addServerLog(`VPN connected – endpoint: ${state.endpoint}, IP: ${state.ip || '?'}`, 'ok');
  } else if (state.status === 'error') {
    addServerLog(`VPN error: ${state.error}`, 'err');
  } else if (state.status === 'disconnected') {
    addServerLog('VPN disconnected', 'warn');
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Settings routes ──────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  res.json(settingsManager.get());
});

app.post('/api/settings', (req, res) => {
  try {
    res.json(settingsManager.save(req.body || {}));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── VPN routes ──────────────────────────────────────────────────────────────

app.get('/api/vpn/configs', async (_req, res) => {
  try {
    res.json({ configs: await vpnManager.listConfigs() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vpn/configs/upload', async (req, res) => {
  const { filename, content } = req.body || {};
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'filename is required' });
  }
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content (base64) is required' });
  }
  // Reject payloads larger than 1 MB (base64 encoded) to prevent DoS
  const MAX_CONTENT_BYTES = 1 * 1024 * 1024;
  if (content.length > MAX_CONTENT_BYTES) {
    return res.status(400).json({ error: 'File too large (max 1 MB)' });
  }
  try {
    const buffer = Buffer.from(content, 'base64');
    const saved  = await vpnManager.saveConfig(filename, buffer);
    const configs = await vpnManager.listConfigs();
    res.json({ saved, configs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/vpn/status', (_req, res) => {
  res.json(vpnManager.getStatus());
});

app.post('/api/vpn/connect', (req, res) => {
  const { config, username, password } = req.body || {};
  if (!config || !username || !password) {
    return res.status(400).json({ error: 'config, username and password are required' });
  }
  try {
    // connect() validates synchronously and starts the VPN process in the
    // background.  The UI tracks progress via WebSocket state updates.
    vpnManager.connect(config, username, password);
    res.json({ message: 'VPN connection initiated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vpn/disconnect', async (_req, res) => {
  try {
    await vpnManager.disconnect();
    streamManager.setSourceUrl(null);
    res.json({ message: 'VPN disconnected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stream routes ────────────────────────────────────────────────────────────

app.post('/api/stream/fetch-url', async (req, res) => {
  const { targetUrl, searchString } = req.body || {};
  try {
    const url = await streamManager.fetchSkyUrl(targetUrl, searchString);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/external-ip', async (_req, res) => {
  const SERVICES = [
    'https://ifconfig.io/ip',
    'https://api.ipify.org',
    'https://checkip.amazonaws.com',
  ];
  for (const svc of SERVICES) {
    try {
      const r = await fetch(svc, { timeout: 5000 });
      if (r.ok) {
        const ip = (await r.text()).trim();
        return res.json({ ip });
      }
    } catch (_) { /* try next service */ }
  }
  res.status(503).json({ error: 'Could not determine external IP' });
});

app.get('/api/stream/status', (_req, res) => {
  res.json(streamManager.getStatus());
});

app.post('/api/stream/start', async (req, res) => {
  const { url, port } = req.body || {};
  if (!url || !port) {
    return res.status(400).json({ error: 'url and port are required' });
  }
  try {
    await streamManager.startProxy(url, parseInt(port, 10));
    res.json({ message: `Stream proxy started on port ${port}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stream/stop', async (_req, res) => {
  try {
    await streamManager.stopProxy();
    res.json({ message: 'Stream proxy stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats route ──────────────────────────────────────────────────────────────

app.get('/api/stats', async (_req, res) => {
  try {
    res.json(await statsMonitor.getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stats/vpn-data/reset', (_req, res) => {
  statsMonitor.resetVpnTraffic();
  res.json({ message: 'VPN traffic counters reset' });
});

// ── WebSocket – push live state every second ─────────────────────────────────

wss.on('connection', (ws) => {
  // Track the last log entry id sent to this particular client so that each
  // push only includes new entries (delta), keeping bandwidth low even when
  // the circular buffer is full.  On first push all buffered entries are
  // forwarded so the client gets a backfill of recent events on connect.
  let lastSentLogId = 0;

  const interval = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      const newEntries = serverLog.filter(e => e.id > lastSentLogId);
      if (newEntries.length > 0) lastSentLogId = newEntries[newEntries.length - 1].id;
      ws.send(JSON.stringify({
        vpn:       vpnManager.getStatus(),
        stream:    streamManager.getStatus(),
        stats:     await statsMonitor.getStats(),
        serverLog: newEntries,
        ts:        Date.now(),
      }));
    } catch (_) { /* ignore */ }
  }, 1000);

  ws.on('close', () => clearInterval(interval));
  ws.on('error', () => clearInterval(interval));
});

// ── Auto-stop stream when VPN drops / auto-fetch URL when VPN connects ────────

let _prevVpnStatusForStream = null;

vpnManager.on('status', (state) => {
  const prev = _prevVpnStatusForStream;
  _prevVpnStatusForStream = state.status;

  if (state.status === 'disconnected' || state.status === 'error') {
    if (streamManager.getStatus().sourceUrl) {
      addServerLog('Stream URL cleared because VPN dropped', 'warn');
    }
    streamManager.setSourceUrl(null);
  } else if (state.status === 'connected' && prev !== 'connected') {
    // VPN just came up – always clear the old URL and re-fetch a fresh one
    if (streamManager.getStatus().sourceUrl) {
      addServerLog('Stream URL cleared for fresh VPN connection', 'info');
    }
    streamManager.setSourceUrl(null);
    autoFetchStreamUrl().catch(() => {});
  }
});

// ── Auto-management: HLS proxy always on, VPN on-demand ─────────────────────
//
// Rules:
//   1. HLS proxy starts automatically on the configured port at server boot.
//   2. When clientCount goes 0 → ≥1: connect VPN (using saved credentials),
//      then auto-detect the Live Stream URL.
//   3. When clientCount stays at 0 for the configured timeout: disconnect VPN.
//      A timeout of 0 disables the auto-disconnect behaviour entirely.

let _noClientTimer   = null;
let _autoFetchActive = false;

/** Fetch stream URL via Playwright + fall back to saved settings URL */
async function autoFetchStreamUrl() {
  if (_autoFetchActive) return;
  _autoFetchActive = true;
  try {
    const s = settingsManager.get();
    if (s.fetchLiveUrlEnabled === false) {
      const fallback = s.streamFallbackUrl || s.streamUrl;
      if (fallback) {
        streamManager.setSourceUrl(fallback);
        addServerLog(`Live URL auto-detection disabled – using fallback URL: ${fallback}`, 'info');
      } else {
        addServerLog('Live URL auto-detection disabled and no fallback URL configured; proxy will serve 503 until a URL is set', 'warn');
      }
      return;
    }
    addServerLog('Auto-detecting Live Stream URL…', 'info');
    const url = await streamManager.fetchSkyUrl(s.fetchTargetUrl ?? undefined, s.fetchSearchString ?? undefined);
    streamManager.setSourceUrl(url);
    settingsManager.save({ streamUrl: url });
    addServerLog(`Live Stream URL auto-detected: ${url}`, 'ok');
  } catch (err) {
    addServerLog(`Stream URL auto-detect failed: ${err.message} – trying saved URL`, 'warn');
    const s = settingsManager.get();
    const fallback = s.streamUrl || s.streamFallbackUrl;
    if (fallback) {
      streamManager.setSourceUrl(fallback);
      addServerLog(`Using saved stream URL: ${fallback}`, 'info');
    } else {
      addServerLog('No saved stream URL available; proxy will serve 503 until a URL is set', 'warn');
    }
  } finally {
    _autoFetchActive = false;
  }
}

// Client connected → connect VPN (if needed) + fetch stream URL
streamManager.on('firstClientConnected', () => {
  addServerLog('Client connected to HLS proxy', 'info');

  // Cancel any pending VPN-disconnect timer
  if (_noClientTimer) {
    clearTimeout(_noClientTimer);
    _noClientTimer = null;
    addServerLog('VPN disconnect timer cancelled (client reconnected)', 'info');
  }

  const vpnStatus = vpnManager.getStatus();
  if (vpnStatus.status === 'disconnected' || vpnStatus.status === 'error') {
    const s = settingsManager.get();
    if (s.vpnEndpoint && s.vpnUsername && s.vpnPassword) {
      addServerLog(`Auto-connecting VPN to ${s.vpnEndpoint}…`, 'info');
      try {
        vpnManager.connect(s.vpnEndpoint, s.vpnUsername, s.vpnPassword);
        // Stream URL will be fetched once the VPN 'connected' event fires (below)
      } catch (connErr) {
        addServerLog(`Auto-connect VPN failed: ${connErr.message}`, 'err');
      }
    } else {
      addServerLog('Client connected but VPN credentials not configured – cannot auto-connect', 'warn');
    }
  } else if (vpnStatus.status === 'connected' && !streamManager.getStatus().sourceUrl) {
    // VPN already up but no stream URL yet (e.g. URL was cleared) – re-fetch
    autoFetchStreamUrl().catch(() => {});
  }
});

// All clients gone → start countdown before disconnecting VPN (if timeout is configured)
streamManager.on('noClientsLeft', () => {
  const timeoutMin = settingsManager.get().vpnDisconnectTimeoutMin ?? 5;
  if (timeoutMin <= 0) {
    addServerLog('No clients – VPN auto-disconnect is disabled', 'info');
    return;
  }
  const timeoutMs = timeoutMin * 60 * 1000;
  addServerLog(`No clients – VPN will disconnect in ${timeoutMin} minute${timeoutMin === 1 ? '' : 's'} if no client reconnects`, 'warn');
  if (_noClientTimer) clearTimeout(_noClientTimer);
  _noClientTimer = setTimeout(async () => {
    _noClientTimer = null;
    addServerLog(`No clients for ${timeoutMin} minute${timeoutMin === 1 ? '' : 's'} – clearing stream URL and disconnecting VPN`, 'warn');
    streamManager.setSourceUrl(null);
    await vpnManager.disconnect().catch(() => {});
  }, timeoutMs);
});

// ── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.CONTROL_PORT || '3000', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Sky TG24 Proxy – control panel on http://0.0.0.0:${PORT}`);
  // Auto-start the HLS proxy on the configured stream port so it is always
  // available, even before a VPN connection or stream URL is set.
  const settings = settingsManager.get();
  const streamPort = settings.streamPort || 6443;
  streamManager.startProxy(null, streamPort).catch((err) => {
    addServerLog(`Failed to auto-start HLS proxy on port ${streamPort}: ${err.message}`, 'err');
    console.error('[server] Failed to auto-start HLS proxy:', err.message);
  });
});

// Graceful shutdown
const shutdown = async () => {
  await vpnManager.disconnect();
  await streamManager.stopProxy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
