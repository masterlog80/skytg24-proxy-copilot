'use strict';

const express    = require('express');
const fs         = require('fs');
const http       = require('http');
const fetch      = require('node-fetch');
const puppeteer  = require('puppeteer-core');
const { URL }    = require('url');

const SKY_PAGE_URL = 'https://tg24.sky.it/diretta';
const PROXY_HOST   = process.env.PROXY_HOST || 'localhost';

/**
 * Return true when *filePath* exists and is executable by the current process.
 * Uses fs.existsSync() as the primary check so that the result matches the
 * validation Puppeteer itself performs (it throws "Browser was not found" when
 * existsSync returns false).  A secondary accessSync(X_OK) call filters out
 * paths that exist on the filesystem but are not executable.
 */
function isExecutable(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to resolve *cmd* via the shell's PATH using `which`.
 * Returns the full path string, or null on failure.
 */
function which(cmd) {
  try {
    const { execFileSync } = require('child_process');
    const result = execFileSync('which', [cmd], { encoding: 'utf8', timeout: 3000 }).trim();
    return result || null;
  } catch {
    return null;
  }
}

// Browser command names tried as a last-resort PATH lookup.
const CHROMIUM_COMMAND_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

/**
 * Resolve the path to a Chrome or Chromium executable.
 *
 * Priority:
 *  1. CHROME_BIN environment variable (explicit override).
 *  2. Ordered candidate paths – on arm64 Chromium paths come first because
 *     Google Chrome has no official arm64 Linux build; stubs at the
 *     google-chrome-stable path would exist but fail at runtime.
 *  3. Shell PATH lookup via `which` for common Chromium command names.
 *
 * Returns the resolved path, or null when nothing is found.
 */
function detectChromePath() {
  const isArm64 = process.arch === 'arm64';

  if (process.env.CHROME_BIN) {
    const bin = process.env.CHROME_BIN;
    // On arm64, skip google-chrome-* paths set via CHROME_BIN: there is no
    // official Google Chrome arm64 Linux package and any file found there is
    // most likely a non-functional stub or a broken symlink target.
    if (isArm64 && /google-chrome/.test(bin)) {
      console.warn(
        `arm64 detected – ignoring CHROME_BIN "${bin}" (no official Google Chrome arm64 build). ` +
        'Falling back to Chromium candidate paths.'
      );
    } else {
      try {
        if (isExecutable(bin)) return bin;
        console.warn(`CHROME_BIN is set to "${bin}" but no executable was found there – falling back to candidate paths.`);
      } catch (err) {
        console.warn(`Could not check CHROME_BIN path "${bin}": ${err.message} – falling back to candidate paths.`);
      }
    }
  }

  // On arm64 Chromium paths are listed first; on amd64 Google Chrome is tried
  // first (preferred when both are installed).
  const candidates = isArm64
    ? [
        // Linux arm64 – Chromium
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/local/bin/chromium',
        '/snap/bin/chromium',
        // macOS Apple Silicon
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ]
    : [
        // Linux amd64 – Google Chrome
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-unstable',
        // Linux amd64 – Chromium fallback
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/local/bin/chromium',
        '/snap/bin/chromium',
        // macOS Intel
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ];

  for (const p of candidates) {
    try {
      if (isExecutable(p)) return p;
    } catch { /* ignore */ }
  }

  // Last resort: ask the shell where chromium lives (covers non-standard
  // install prefixes such as Homebrew on macOS or custom Linux setups).
  for (const cmd of CHROMIUM_COMMAND_NAMES) {
    const p = which(cmd);
    if (p && isExecutable(p)) return p;
  }

  return null;
}

// How long (ms) to wait for a .m3u8 request to appear after page load
const BROWSER_FETCH_TIMEOUT_MS = 30_000;

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

// How often (ms) to re-fetch stream info (resolution / frame-rate) while active
const STREAM_INFO_POLL_MS = 10_000;

class StreamManager {
  constructor() {
    this._server       = null;
    this._pollInterval = null;
    this._state        = {
      active:      false,
      port:        null,
      sourceUrl:   null,
      clientCount: 0,
      resolution:  null,
      frameRate:   null,
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Launch a headless browser, load the Sky TG24 diretta page, and intercept
   * the first outgoing network request for a .m3u8 HLS stream.  The player
   * only initialises after all JS / plugins have run, so a plain HTTP fetch of
   * the page source is not sufficient – we need to execute the page fully.
   */
  async fetchSkyUrl() {
    // Detect lazily on every call so changes to the filesystem (e.g. Chrome
    // being installed after the server started) are picked up automatically.
    const chromeBin = detectChromePath();
    if (!chromeBin) {
      throw new Error(
        'No Chrome or Chromium executable was found. ' +
        'Install Google Chrome / Chromium, or set the CHROME_BIN environment variable ' +
        'to the full path of the browser executable.'
      );
    }

    let browser;
    try {
      try {
        browser = await puppeteer.launch({
          executablePath: chromeBin,
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--mute-audio',
          ],
        });
      } catch (launchErr) {
        throw new Error(
          `Failed to launch browser at "${chromeBin}": ${launchErr.message}. ` +
          'Make sure Google Chrome or Chromium is correctly installed, or set the ' +
          'CHROME_BIN environment variable to the full path of the browser executable.'
        );
      }

      const page = await browser.newPage();
      await page.setUserAgent(FETCH_HEADERS['User-Agent']);
      await page.setExtraHTTPHeaders({
        'Accept-Language': FETCH_HEADERS['Accept-Language'],
      });

      // Resolve as soon as the first .m3u8 URL is seen in any outgoing request;
      // remove the listener immediately to avoid redundant calls.
      let resolveM3u8;
      const m3u8Promise = new Promise((resolve) => { resolveM3u8 = resolve; });

      const onRequest = (request) => {
        const url = request.url();
        if (url.includes('.m3u8')) {
          page.off('request', onRequest);
          resolveM3u8(url);
        }
      };
      page.on('request', onRequest);

      await page.goto(SKY_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: BROWSER_FETCH_TIMEOUT_MS });

      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(
            'Stream URL not found. Make sure the VPN is connected to an Italian server, ' +
            'then try again, or enter the URL manually.'
          )),
          BROWSER_FETCH_TIMEOUT_MS,
        );
      });

      try {
        return await Promise.race([m3u8Promise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
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
        this._state  = { active: true, port, sourceUrl, clientCount: 0, resolution: null, frameRate: null };
        // Fetch stream info immediately, then poll on an interval
        this._fetchStreamInfo();
        this._pollInterval = setInterval(() => this._fetchStreamInfo(), STREAM_INFO_POLL_MS);
        resolve();
      });
      srv.on('error', reject);
    });
  }

  /** Stop the HLS proxy */
  stopProxy() {
    return new Promise((resolve) => {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
      if (!this._server) {
        this._state = { active: false, port: null, sourceUrl: null, clientCount: 0, resolution: null, frameRate: null };
        return resolve();
      }
      this._server.close(() => {
        this._server = null;
        this._state  = { active: false, port: null, sourceUrl: null, clientCount: 0, resolution: null, frameRate: null };
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

  /**
   * Fetch the HLS master playlist and extract the resolution and frame-rate of
   * the highest-bandwidth variant stream.  Silently ignored on any error so
   * that normal proxy operation is never interrupted.
   */
  async _fetchStreamInfo() {
    const url = this._state.sourceUrl;
    if (!url) return;
    try {
      const resp = await fetch(url, { headers: FETCH_HEADERS, timeout: 10_000 });
      if (!resp.ok) return;
      const text = await resp.text();
      const lines = text.split('\n');

      let bestBandwidth = -1;
      let bestResolution = null;
      let bestFrameRate  = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

        const bwMatch  = line.match(/BANDWIDTH=(\d+)/i);
        const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
        const fpsMatch = line.match(/FRAME-RATE=([\d.]+)/i);

        const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
        if (bw > bestBandwidth) {
          bestBandwidth  = bw;
          bestResolution = resMatch ? resMatch[1] : null;
          bestFrameRate  = fpsMatch ? parseFloat(fpsMatch[1]) : null;
        }
      }

      if (bestResolution !== null) this._state.resolution = bestResolution;
      if (bestFrameRate  !== null) this._state.frameRate  = bestFrameRate;
    } catch (_) { /* ignore – proxy operation must not be affected */ }
  }

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
