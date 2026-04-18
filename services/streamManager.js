'use strict';

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
      try { await this._proxy(sourceUrl, req, res); }
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

      try { await this._proxy(target, req, res); }
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

  async _proxy(url, req, res) {
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
      // Use the Host header from the incoming request so that rewritten segment
      // URLs point back to whichever address/port the client used to reach us.
      // Validate the header to ensure the port matches our known proxy port and
      // the hostname only contains safe characters before trusting it.
      const proxyHost = this._resolveProxyHost(req.headers.host);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-cache, no-store');
      res.send(this._rewritePlaylist(body, url, proxyHost));
    } else {
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
    // Directory prefix of the base URL (everything up to and including the last '/').
    const dir       = base.href.substring(0, base.href.lastIndexOf('/') + 1);

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
      return `${proxyBase}${Buffer.from(abs).toString('base64')}`;
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
