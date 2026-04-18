'use strict';

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');

const VPNManager    = require('./services/vpnManager');
const StreamManager = require('./services/streamManager');
const StatsMonitor  = require('./services/statsMonitor');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const vpnManager    = new VPNManager();
const streamManager = new StreamManager();
const statsMonitor  = new StatsMonitor();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── VPN routes ──────────────────────────────────────────────────────────────

app.get('/api/vpn/configs', async (_req, res) => {
  try {
    res.json({ configs: await vpnManager.listConfigs() });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    await streamManager.stopProxy();
    res.json({ message: 'VPN disconnected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stream routes ────────────────────────────────────────────────────────────

app.post('/api/stream/fetch-url', async (_req, res) => {
  try {
    const url = await streamManager.fetchSkyUrl();
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ── WebSocket – push live state every second ─────────────────────────────────

wss.on('connection', (ws) => {
  const interval = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({
        vpn:    vpnManager.getStatus(),
        stream: streamManager.getStatus(),
        stats:  await statsMonitor.getStats(),
        ts:     Date.now(),
      }));
    } catch (_) { /* ignore */ }
  }, 1000);

  ws.on('close', () => clearInterval(interval));
  ws.on('error', () => clearInterval(interval));
});

// ── Auto-stop stream when VPN drops ─────────────────────────────────────────

vpnManager.on('status', (state) => {
  if (state.status === 'disconnected' || state.status === 'error') {
    streamManager.stopProxy().catch(() => {});
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.CONTROL_PORT || '3000', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Sky TG24 Proxy – control panel on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
const shutdown = async () => {
  await vpnManager.disconnect();
  await streamManager.stopProxy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
