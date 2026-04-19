'use strict';

const EventEmitter = require('events');
const express    = require('express');
const http       = require('http');
const fs         = require('fs');
const fetch      = require('node-fetch');
const { chromium } = require('playwright');
const { URL }    = require('url');

// Bundled hls.js – read once at startup into memory to avoid per-request file I/O.
// Fails fast with a clear error if the npm package is not installed.
let HLS_JS_CONTENT;
try {
  const hlsJsPath = require.resolve('hls.js/dist/hls.min.js');
  HLS_JS_CONTENT = fs.readFileSync(hlsJsPath, 'utf8');
} catch (e) {
  throw new Error(`hls.js not found. Run: npm install (${e.message})`);
}

const SKY_PAGE_URL = 'https://tg24.sky.it/diretta';
const PROXY_HOST   = process.env.PROXY_HOST || 'localhost';

// How long (ms) to wait for the page to load (goto timeout)
const PAGE_LOAD_TIMEOUT_MS = 30_000;
// How long (ms) to wait for a master.m3u8 request to appear after page load
const BROWSER_FETCH_TIMEOUT_MS = 60_000;
// How long (ms) to wait when probing consent / play buttons
const ELEMENT_INTERACTION_TIMEOUT_MS = 2_000;

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

// Sliding window (ms) within which a unique client IP is counted as active.
// HLS players poll the manifest every few seconds, so 30 s gives ample margin.
const CLIENT_ACTIVE_MS = 30_000;

class StreamManager extends EventEmitter {
  /**
   * @param {() => object} [getVpnStatus]  Optional callback that returns the
   *   current VPN status object.  When provided, its result is appended to
   *   proxy-error log entries so the Event Log shows VPN context alongside
   *   CDN errors, making it easy to see whether a geo-block or routing issue
   *   is the cause of a stream failure.
   */
  constructor(getVpnStatus) {
    super();
    this._getVpnStatus   = typeof getVpnStatus === 'function' ? getVpnStatus : null;
    this._server         = null;
    this._pollInterval   = null;
    this._clientLastSeen = new Map(); // ip → timestamp of last /stream or /proxy request
    this._prevClientCount = 0;        // used to detect 0↔≥1 transitions for events
    this._state          = {
      active:      false,
      port:        null,
      sourceUrl:   null,
      resolution:  null,
      frameRate:   null,
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Emit a 'log' event consumed by server.js and ultimately forwarded to the
   * browser's 🖥 Event Log via the WebSocket push.  Also mirrors to stdout so
   * that Docker / server logs capture the same information.
   *
   * @param {string} msg
   * @param {'ok'|'info'|'warn'|'err'} [type]
   */
  _log(msg, type = 'info') {
    console.log(`[StreamManager][${type}] ${msg}`);
    this.emit('log', { msg, type });
  }

  /**
   * Build a short VPN-context suffix (e.g. " [VPN: connected, IP: 1.2.3.4]")
   * that is appended to error messages so the Event Log immediately shows
   * whether a routing or geo-block issue is to blame for a CDN failure.
   */
  _vpnContext() {
    if (!this._getVpnStatus) return '';
    try {
      const s = this._getVpnStatus();
      if (!s) return '';
      const ip = s.ip ? `, IP: ${s.ip}` : '';
      return ` [VPN: ${s.status}${ip}]`;
    } catch {
      return '';
    }
  }

  /**
   * Launch a headless Chrome browser, load the Sky TG24 diretta page, and
   * intercept the first outgoing network request for a .m3u8 HLS stream.  The
   * player only initialises after all JS / plugins have run, so a plain HTTP
   * fetch of the page source is not sufficient – we need to execute the page
   * fully.
   *
   * @param {string} [targetUrl]    Page URL to navigate to (defaults to SKY_PAGE_URL)
   * @param {string} [searchString] Substring to identify the desired stream URL
   *                                (defaults to 'master.m3u8')
   */
  async fetchSkyUrl(targetUrl, searchString) {
    const pageUrl  = (targetUrl    && targetUrl.trim())    || SKY_PAGE_URL;
    const needle   = (searchString && searchString.trim()) || 'master.m3u8';

    let browser;
    try {
      try {
        browser = await chromium.launch({ headless: true });
      } catch (launchErr) {
        throw new Error(
          `Failed to launch Chrome: ${launchErr.message}. ` +
          'Make sure the Playwright Chromium browser is installed ' +
          '(run: npx playwright install chromium).'
        );
      }

      const context = await browser.newContext({
        userAgent: FETCH_HEADERS['User-Agent'],
        extraHTTPHeaders: {
          'Accept-Language': FETCH_HEADERS['Accept-Language'],
        },
      });
      const page = await context.newPage();

      // Resolve immediately when the needle is found; record any other .m3u8
      // as a fallback in case the needle URL never appears.
      let resolveM3u8;
      let fallbackUrl = null;
      const m3u8Promise = new Promise((resolve) => { resolveM3u8 = resolve; });

      const handleUrl = (url) => {
        if (url.includes(needle)) {
          resolveM3u8(url);
        } else if (url.includes('.m3u8') && !fallbackUrl) {
          fallbackUrl = url;
        }
      };
      const onRequest  = (request)  => handleUrl(request.url());
      // Also scan JSON response bodies: the stream URL (e.g. master.m3u8) is
      // often embedded inside the payload of an API call (e.g. getLivestream)
      // rather than being a separate network request, so checking response.url()
      // alone is not enough.
      const onResponse = async (response) => {
        handleUrl(response.url());
        const ct = (response.headers()['content-type'] || '').toLowerCase();
        if (ct.includes('application/json') || ct.includes('text/javascript')) {
          try {
            const text = await response.text();
            // Extract all absolute URLs from the response body and pass each
            // to handleUrl; stop at characters that cannot appear in a URL
            // but are common JSON delimiters (quotes, braces, brackets, commas).
            const urlMatches = text.match(/https?:\/\/[^\s"'\\,{}\[\]]+/g) || [];
            for (const u of urlMatches) {
              handleUrl(u);
            }
          } catch (err) {
            // Body read failed – log at debug level so production noise is low
            console.debug('[StreamManager] Could not read response body from', response.url(), '–', err.message);
          }
        }
      };
      page.on('request', onRequest);
      page.on('response', onResponse);

      // Navigate and wait for the full page (all scripts) to load.
      await page.goto(pageUrl, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });

      // Dismiss cookie / GDPR consent banners so they don't block the player.
      const consentSelectors = [
        // OneTrust / Didomi / generic accept buttons
        '#onetrust-accept-btn-handler',
        '.didomi-continue-without-agreeing',
        '[aria-label*="Accept"]',
        '[aria-label*="Accetta"]',
        'button[class*="accept"]',
        'button[class*="agree"]',
        'button[class*="consent"]',
      ];
      for (const sel of consentSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: ELEMENT_INTERACTION_TIMEOUT_MS })) {
            await btn.click({ timeout: ELEMENT_INTERACTION_TIMEOUT_MS });
            break;
          }
        } catch (err) {
          // Element not present or timed out – try the next selector
          if (err.name !== 'TimeoutError') throw err;
        }
      }

      // Attempt to click any visible play button to trigger HLS initialisation.
      const playSelectors = [
        'button[aria-label*="play" i]',
        'button[aria-label*="riproduci" i]',
        '.vjs-big-play-button',
        '.play-button',
        '[class*="PlayButton"]',
        '[class*="play-btn"]',
      ];
      for (const sel of playSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: ELEMENT_INTERACTION_TIMEOUT_MS })) {
            await btn.click({ timeout: ELEMENT_INTERACTION_TIMEOUT_MS });
            break;
          }
        } catch (err) {
          // Element not present or timed out – try the next selector
          if (err.name !== 'TimeoutError') throw err;
        }
      }

      // After the page has loaded and the player has been nudged, wait up to
      // BROWSER_FETCH_TIMEOUT_MS for the HLS manifest request to appear.
      // If the needle URL never arrives but a generic .m3u8 was captured, use that.
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => {
            if (fallbackUrl) {
              resolveM3u8(fallbackUrl);
            } else {
              reject(new Error(
                'Stream URL not found. Make sure the VPN is connected to an Italian server, ' +
                'then try again, or enter the URL manually.'
              ));
            }
          },
          BROWSER_FETCH_TIMEOUT_MS,
        );
      });

      try {
        return await Promise.race([m3u8Promise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
        page.off('request', onRequest);
        page.off('response', onResponse);
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  /** Start the HLS reverse-proxy on *port* forwarding *sourceUrl*.
   *  *sourceUrl* is optional; if omitted the proxy starts in "waiting" mode and
   *  returns HTTP 503 on /stream until setSourceUrl() is called.
   */
  async startProxy(sourceUrl = null, port) {
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

    // Track unique client IPs on stream/proxy requests so that clientCount
    // reflects real viewers rather than individual HTTP request cycles.
    // Also emits 'firstClientConnected' / 'noClientsLeft' events when the
    // count crosses the 0 ↔ ≥1 boundary.
    app.use((req, _res, next) => {
      if (req.path === '/stream' || req.path === '/proxy') {
        const ip = req.ip || req.socket?.remoteAddress;
        if (ip) {
          this._clientLastSeen.set(ip, Date.now());
          this._updateClientCount();
        }
      }
      next();
    });

    // Serve bundled hls.js locally (no CDN dependency; content pre-loaded at startup)
    app.get('/hls.min.js', (_req, res) => {
      res.set('Content-Type', 'application/javascript; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(HLS_JS_CONTENT);
    });

    // Root / /player → browser player HTML (hls.js)
    const playerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Sky TG24 Live</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: sans-serif; }
    video { width: 100%; max-height: 100vh; }
    #msg { color: #fff; font-size: 16px; padding: 16px; text-align: center; }
  </style>
</head>
<body>
  <div id="msg">Loading player…</div>
  <video id="video" controls autoplay muted playsinline style="display:none" aria-label="Sky TG24 Live Stream"></video>
  <script src="/hls.min.js"></script>
  <script>
    const video = document.getElementById('video');
    const msgEl = document.getElementById('msg');
    const streamUrl = window.location.origin + '/stream';

    function showError(text) {
      msgEl.textContent = text;
      msgEl.style.display = 'block';
    }

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function() {
        msgEl.style.display = 'none';
        video.style.display = '';
        video.play().catch(function() {});
      });
      hls.on(Hls.Events.ERROR, function(_, data) {
        if (data.fatal) {
          showError('Stream error (' + data.type + '). Make sure the proxy is running and VPN is connected.');
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      msgEl.style.display = 'none';
      video.style.display = '';
      video.src = streamUrl;
      video.play().catch(function() {});
    } else {
      showError('HLS playback is not supported in this browser. Open the stream URL in VLC instead.');
    }
  </script>
</body>
</html>`;

    app.get('/', (_req, res) => {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(playerHtml);
    });

    app.get('/player', (_req, res) => {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(playerHtml);
    });

    app.get('/stream', async (req, res) => {
      const url = this._state.sourceUrl;
      if (!url) return res.status(503).send('Stream not available yet. Waiting for VPN connection and URL detection.');
      try { await this._proxy(url, req, res); }
      catch (e) { res.status(502).send(e.message); }
    });

    // Generic proxy endpoint used by rewritten playlist URLs.
    // Only fetches from allowlisted CDN hostnames to prevent SSRF.
    app.get('/proxy', async (req, res) => {
      if (!req.query.url) return res.status(400).send('Missing url param');
      let target;
      try { target = Buffer.from(req.query.url, 'base64url').toString('utf8'); }
      catch { return res.status(400).send('Bad url encoding'); }

      if (!/^https?:\/\//i.test(target)) {
        return res.status(400).send('Invalid proxied URL scheme');
      }
      if (!isAllowedProxyTarget(target)) {
        return res.status(403).send('Proxy target host not allowed');
      }

      try { await this._proxy(target, req, res); }
      catch (e) { res.status(502).send(e.message); }
    });

    return new Promise((resolve, reject) => {
      const srv = http.createServer(app);
      srv.listen(port, '0.0.0.0', () => {
        this._server = srv;
        this._clientLastSeen.clear();
        this._prevClientCount = 0;
        this._state  = { active: true, port, sourceUrl, resolution: null, frameRate: null };
        if (sourceUrl) {
          this._log(`Proxy started on port ${port}. Source URL: ${sourceUrl}${this._vpnContext()}`, 'ok');
          // Fetch stream info immediately, then poll on an interval
          this._fetchStreamInfo();
          this._pollInterval = setInterval(() => this._fetchStreamInfo(), STREAM_INFO_POLL_MS);
        } else {
          this._log(`Proxy started on port ${port}. Waiting for stream URL.`, 'ok');
        }
        resolve();
      });
      srv.on('error', (err) => {
        this._log(`Proxy server failed to start on port ${port}: ${err.message}`, 'err');
        reject(err);
      });
    });
  }

  /** Stop the HLS proxy */
  stopProxy() {
    return new Promise((resolve) => {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
      this._clientLastSeen.clear();
      this._prevClientCount = 0;
      if (!this._server) {
        this._state = { active: false, port: null, sourceUrl: null, resolution: null, frameRate: null };
        return resolve();
      }
      this._log('Proxy stopped', 'warn');
      this._server.close(() => {
        this._server = null;
        this._state  = { active: false, port: null, sourceUrl: null, resolution: null, frameRate: null };
        resolve();
      });
      // Force-close any lingering keep-alive connections
      this._server.closeAllConnections?.();
    });
  }

  getStatus() {
    const clientCount = this._updateClientCount();
    return { ...this._state, clientCount };
  }

  /**
   * Update the live stream source URL on the running proxy without restarting
   * the server.  Pass null to clear the URL (proxy will return 503 until a
   * new URL is provided).
   *
   * @param {string|null} url
   */
  setSourceUrl(url) {
    this._state.sourceUrl = url || null;
    if (url) {
      this._fetchStreamInfo();
      if (!this._pollInterval) {
        this._pollInterval = setInterval(() => this._fetchStreamInfo(), STREAM_INFO_POLL_MS);
      }
    } else {
      clearInterval(this._pollInterval);
      this._pollInterval   = null;
      this._state.resolution = null;
      this._state.frameRate  = null;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Prune stale client entries, compute the current active-client count, and
   * emit 'firstClientConnected' or 'noClientsLeft' when the count crosses the
   * 0 ↔ ≥1 boundary.  Called both from the request middleware (immediate) and
   * from getStatus() (periodic via the WebSocket ticker).
   *
   * @returns {number} current active client count
   */
  _updateClientCount() {
    const now = Date.now();
    for (const [ip, ts] of this._clientLastSeen) {
      if (now - ts >= CLIENT_ACTIVE_MS) this._clientLastSeen.delete(ip);
    }
    const count = this._clientLastSeen.size;
    if (this._prevClientCount === 0 && count >= 1) {
      this.emit('firstClientConnected');
    } else if (this._prevClientCount >= 1 && count === 0) {
      this.emit('noClientsLeft');
    }
    this._prevClientCount = count;
    return count;
  }

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

  async _proxy(url, req, res) {
    let upstream;
    try {
      upstream = await fetch(url, {
        headers: {
          ...FETCH_HEADERS,
          ...(req.headers.range ? { Range: req.headers.range } : {}),
        },
        timeout: 30_000,
      });
    } catch (fetchErr) {
      // Surface network-level failures (DNS, TCP, timeout) in the Event Log so
      // the user can see whether a routing or VPN issue is the cause.
      this._log(
        `Proxy fetch failed – could not reach CDN: ${fetchErr.message} (URL: ${url})${this._vpnContext()}`,
        'err',
      );
      throw fetchErr;
    }

    const ct = upstream.headers.get('content-type') || '';
    const isPlaylist =
      ct.includes('mpegurl') ||
      ct.includes('m3u8')    ||
      url.includes('.m3u8')  ||
      (ct.includes('text/plain') && url.includes('m3u'));

    if (isPlaylist) {
      const body = await upstream.text();
      if (!upstream.ok) {
        // Log the CDN-level error so it appears in the Event Log with VPN context,
        // helping users distinguish between a geo-block (VPN issue) and an expired
        // or invalid stream URL.
        this._log(
          `CDN returned HTTP ${upstream.status} for playlist${this._vpnContext()} — URL: ${url}`,
          'warn',
        );
        // Forward upstream error status so hls.js receives a proper HTTP error
        // rather than a 200 with invalid content that causes a silent parse failure.
        return res.status(upstream.status).send(body);
      }
      // Use the Host header from the incoming request so that rewritten segment
      // URLs point back to whichever address/port the client used to reach us.
      // Validate the header to ensure the port matches our known proxy port and
      // the hostname only contains safe characters before trusting it.
      const proxyHost = this._resolveProxyHost(req.headers.host);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-cache, no-store');
      res.send(this._rewritePlaylist(body, url, proxyHost));
    } else {
      if (!upstream.ok) {
        // Log non-2xx segment responses so the Event Log reveals CDN errors.
        this._log(
          `CDN returned HTTP ${upstream.status} for segment${this._vpnContext()} — URL: ${url}`,
          'warn',
        );
      }
      res.status(upstream.status);
      res.set('Content-Type', ct);
      const cr = upstream.headers.get('content-range');
      if (cr) res.set('Content-Range', cr);
      upstream.body.pipe(res);
    }
  }

  /**
   * Return the proxy host string (`hostname:port`) to embed in rewritten
   * playlist URLs.  We prefer the value from the request `Host` header so that
   * clients on remote machines get URLs that point back to the correct address.
   * However the header is client-supplied, so we validate it via URL parsing:
   *   • the value must parse as a valid authority (hostname + port)
   *   • the port must match the port we are actually listening on
   * If validation fails we fall back to the server-configured PROXY_HOST.
   */
  _resolveProxyHost(hostHeader) {
    const port = this._state.port;
    if (hostHeader) {
      try {
        // Prepend a scheme so the URL parser can interpret the Host value as an
        // authority component (hostname + optional port).
        const parsed = new URL(`http://${hostHeader}`);
        // Only trust the header when its port matches our listening port.
        // If the port is omitted in the header (parsed.port === ''), parseInt
        // returns NaN and the comparison fails, causing a safe fallback to
        // PROXY_HOST — this is intentional for non-standard proxy ports.
        if (parseInt(parsed.port, 10) === port) {
          return hostHeader;
        }
      } catch {
        // Malformed Host header – fall through to the default below.
      }
    }
    return `${PROXY_HOST}:${port}`;
  }

  /** Rewrite every non-comment line in an M3U8 to go through our /proxy endpoint */
  _rewritePlaylist(content, baseUrl, proxyHost) {
    const base      = new URL(baseUrl);
    const proxyBase = `http://${proxyHost}/proxy?url=`;
    // Directory prefix of the base URL, derived from the path only (not href)
    // so that query-string tokens containing '/' (e.g. Akamai acl=/*~hmac=…)
    // do not corrupt the resolved base directory for relative playlist entries.
    const pathDir   = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
    const dir       = `${base.protocol}//${base.host}${pathDir}`;

    // Resolve a URI from the playlist (absolute or relative) into a fully
    // proxied URL pointing back to our /proxy endpoint.
    const resolveUri = (uri) => {
      let abs;
      if (/^https?:\/\//i.test(uri)) {
        abs = uri;
      } else if (uri.startsWith('//')) {
        abs = `${base.protocol}${uri}`;
      } else if (uri.startsWith('/')) {
        abs = `${base.protocol}//${base.host}${uri}`;
      } else {
        abs = dir + uri;
      }
      return `${proxyBase}${Buffer.from(abs).toString('base64url')}`;
    };

    return content
      .split('\n')
      .map(line => {
        const t = line.trim();
        if (!t) return line;

        if (t.startsWith('#')) {
          // Rewrite URI="..." attributes inside tag lines (e.g. #EXT-X-MEDIA,
          // #EXT-X-KEY, #EXT-X-I-FRAME-STREAM-INF) so that audio renditions,
          // encryption keys and i-frame playlists are also fetched via the proxy.
          return line.replace(/\bURI="([^"]+)"/g, (_match, uri) => `URI="${resolveUri(uri)}"`);
        }

        return resolveUri(t);
      })
      .join('\n');
  }
}

module.exports = StreamManager;
