'use strict';

const express = require('express');
const http    = require('http');
const fetch   = require('node-fetch');
const { URL } = require('url');

const SKY_PAGE_URL = 'https://tg24.sky.it/diretta';
const PROXY_HOST   = process.env.PROXY_HOST || 'localhost';

// Ordered list of patterns to locate the HLS stream URL in the page source
const HLS_PATTERNS = [
  /https:\/\/hlslive-web-dai-gcdn-skycdn-it\.akamaized\.net[^\s"'<>\\\n]+\.m3u8(?:\?[^\s"'<>\\\n]*)?/,
  /https:\/\/[a-z0-9-]+(?:\.skycdn\.it|\.akamaized\.net)[^\s"'<>\\\n]+\.m3u8(?:\?[^\s"'<>\\\n]*)?/,
  /https:\/\/[^\s"'<>\\\n]+\/master\.m3u8(?:\?[^\s"'<>\\\n]*)?/,
];

// Allowlist of hostname suffixes the HLS proxy is permitted to fetch from.
// This prevents the /proxy endpoint from being used as an open SSRF relay.
const ALLOWED_PROXY_HOSTS = [
  '.akamaized.net',
  '.skycdn.it',
  '.sky.it',
  '.akamai.net',
  '.akamaihd.net',
  '.edgekey.net',
];

/** Return true when the hostname of *url* is on the allowlist */
function isAllowedProxyTarget(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl);
    return ALLOWED_PROXY_HOSTS.some(suffix => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

const FETCH_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
  'Referer':         'https://tg24.sky.it/',
};

class StreamManager {
  constructor() {
    this._server = null;
    this._state  = {
      active:      false,
      port:        null,
      sourceUrl:   null,
      clientCount: 0,
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Scrape the Sky TG24 diretta page and return the first HLS URL found */
  async fetchSkyUrl() {
    const res = await fetch(SKY_PAGE_URL, {
      headers: FETCH_HEADERS,
      timeout: 20_000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from Sky TG24`);

    const html = await res.text();

    // Normalise JSON and HTML escape sequences *before* pattern matching so
    // that the URL patterns work regardless of how the URL is embedded in the
    // page (e.g. JSON \/ for / or \u0026 for &, or the HTML entity &amp;).
    // Without this, the backslash in \/ stops the character class
    // [^\s"'<>\\\n] before reaching /master.m3u8, causing all patterns to fail.
    // &amp; is decoded before \u0026 to prevent chained double-unescaping
    // (e.g. \u0026amp; → &amp; → & would be incorrect).
    const normalized = html
      .replace(/\\\//g, '/')       // JSON \/ → /
      .replace(/&amp;/g, '&')      // HTML entity → & (must precede \u0026 decode)
      .replace(/\\u0026/gi, '&');  // JSON \u0026 → &

    for (const pat of HLS_PATTERNS) {
      const m = normalized.match(pat);
      if (m) {
        // Remove escaped double-quotes that JSON encoding may add around the URL.
        // URL strings never legitimately contain \" so this is safe.
        return m[0].replace(/\\"/g, '');
      }
    }

    throw new Error(
      'Stream URL not found in page. Make sure the VPN is connected to an Italian server, ' +
      'then try again, or enter the URL manually.'
    );
  }

  /** Start the HLS reverse-proxy on *port* forwarding *sourceUrl* */
  async startProxy(sourceUrl, port) {
    if (this._server) await this.stopProxy();

    const app = express();

    // CORS – allow any local player
    app.use((_req, res, next) => {
      res.set('Access-Control-Allow-Origin',  '*');
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Range');
      if (_req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    // Count active request cycles as "clients"
    app.use((_req, res, next) => {
      this._state.clientCount++;
      const done = () => { this._state.clientCount = Math.max(0, this._state.clientCount - 1); };
      res.on('finish', done);
      res.on('close',  done);
      next();
    });

    // Root → master playlist
    app.get('/', async (req, res) => {
      try { await this._proxy(sourceUrl, req, res, port); }
      catch (e) { res.status(502).send(e.message); }
    });

    app.get('/stream', async (req, res) => {
      try { await this._proxy(sourceUrl, req, res, port); }
      catch (e) { res.status(502).send(e.message); }
    });

    // Generic proxy endpoint used by rewritten playlist URLs.
    // Only fetches from allowlisted CDN hostnames to prevent SSRF.
    app.get('/proxy', async (req, res) => {
      if (!req.query.url) return res.status(400).send('Missing url param');
      let target;
      try { target = Buffer.from(req.query.url, 'base64').toString('utf8'); }
      catch { return res.status(400).send('Bad url encoding'); }

      if (!/^https?:\/\//i.test(target)) {
        return res.status(400).send('Invalid proxied URL scheme');
      }
      if (!isAllowedProxyTarget(target)) {
        return res.status(403).send('Proxy target host not allowed');
      }

      try { await this._proxy(target, req, res, port); }
      catch (e) { res.status(502).send(e.message); }
    });

    return new Promise((resolve, reject) => {
      const srv = http.createServer(app);
      srv.listen(port, '0.0.0.0', () => {
        this._server = srv;
        this._state  = { active: true, port, sourceUrl, clientCount: 0 };
        resolve();
      });
      srv.on('error', reject);
    });
  }

  /** Stop the HLS proxy */
  stopProxy() {
    return new Promise((resolve) => {
      if (!this._server) {
        this._state = { active: false, port: null, sourceUrl: null, clientCount: 0 };
        return resolve();
      }
      this._server.close(() => {
        this._server = null;
        this._state  = { active: false, port: null, sourceUrl: null, clientCount: 0 };
        resolve();
      });
      // Force-close any lingering keep-alive connections
      this._server.closeAllConnections?.();
    });
  }

  getStatus() {
    return { ...this._state };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  async _proxy(url, req, res, port) {
    const upstream = await fetch(url, {
      headers: {
        ...FETCH_HEADERS,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      timeout: 30_000,
    });

    const ct = upstream.headers.get('content-type') || '';
    const isPlaylist =
      ct.includes('mpegurl') ||
      ct.includes('m3u8')    ||
      url.includes('.m3u8')  ||
      (ct.includes('text/plain') && url.includes('m3u'));

    if (isPlaylist) {
      const body = await upstream.text();
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-cache, no-store');
      res.send(this._rewritePlaylist(body, url, port));
    } else {
      res.status(upstream.status);
      res.set('Content-Type', ct);
      const cr = upstream.headers.get('content-range');
      if (cr) res.set('Content-Range', cr);
      upstream.body.pipe(res);
    }
  }

  /** Rewrite every non-comment line in an M3U8 to go through our /proxy endpoint */
  _rewritePlaylist(content, baseUrl, port) {
    const base     = new URL(baseUrl);
    const proxyBase = `http://${PROXY_HOST}:${port}/proxy?url=`;

    return content
      .split('\n')
      .map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;

        let abs;
        if (/^https?:\/\//i.test(t)) {
          abs = t;
        } else if (t.startsWith('//')) {
          abs = `${base.protocol}${t}`;
        } else if (t.startsWith('/')) {
          abs = `${base.protocol}//${base.host}${t}`;
        } else {
          const dir = base.href.substring(0, base.href.lastIndexOf('/') + 1);
          abs = dir + t;
        }

        return `${proxyBase}${Buffer.from(abs).toString('base64')}`;
      })
      .join('\n');
  }
}

module.exports = StreamManager;
