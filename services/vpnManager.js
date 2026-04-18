'use strict';

const { spawn, execFileSync } = require('child_process');
const EventEmitter   = require('events');
const fs             = require('fs');
const https          = require('https');
const path           = require('path');

const VPN_CONFIG_DIR = process.env.VPN_CONFIG_DIR || path.join(__dirname, '..', 'config', 'vpn');
const CREDS_FILE     = '/tmp/.vpn_creds';
const LOG_FILE       = '/tmp/openvpn.log';
const PID_FILE       = '/tmp/openvpn.pid';
const CONNECT_TIMEOUT_MS = 90_000;

// Policy-routing constants used to keep management-UI traffic on eth0 while
// the VPN's redirect-gateway handles all other outbound traffic.
const POLICY_ROUTE_TABLE  = '100';   // secondary routing table id
const POLICY_ROUTE_FWMARK = '0x1';  // iptables / ip-rule firewall mark

class VPNManager extends EventEmitter {
  constructor() {
    super();
    this._proc              = null;
    this._logWatcher        = null;
    this._savedGw           = null;  // { gateway, dev } captured before VPN changes routing
    this._policyRouteActive = false;
    this._state             = {
      status:      'disconnected', // disconnected | connecting | connected | error
      endpoint:    null,
      ip:          null,
      connectedAt: null,
      error:       null,
    };
  }

  /** Return array of { file, name } for every .ovpn file in VPN_CONFIG_DIR */
  async listConfigs() {
    try {
      await fs.promises.mkdir(VPN_CONFIG_DIR, { recursive: true });
      const files = await fs.promises.readdir(VPN_CONFIG_DIR);
      return files
        .filter(f => f.toLowerCase().endsWith('.ovpn'))
        .map(f => ({
          file: f,
          name: f
            .replace(/\.ovpn$/i, '')
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase()),
        }));
    } catch {
      return [];
    }
  }

  /** Connect using a named .ovpn file and plaintext credentials.
   *  Validates inputs synchronously (throws on error) then starts the async
   *  VPN process in the background.  Subsequent state changes are delivered
   *  via the 'status' EventEmitter event so callers can return to the client
   *  immediately without waiting for the full handshake.
   */
  connect(configFile, username, password) {
    // Sanitise: must be a plain filename, not a path
    if (path.basename(configFile) !== configFile) {
      throw new Error('Invalid config filename');
    }
    const configPath = path.join(VPN_CONFIG_DIR, configFile);
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configFile}`);
    }

    // Prevent a second connect while one is already in progress.
    if (this._state.status === 'connecting') {
      throw new Error('A connection attempt is already in progress');
    }

    // Fire-and-forget: the async handshake runs in the background; all state
    // changes are broadcast via _setState / 'status' events.
    this._doConnect(configFile, configPath, username, password).catch(err => {
      this._setState({ status: 'error', error: err.message });
    });
  }

  async _doConnect(configFile, configPath, username, password) {
    // Kill any existing connection first
    if (this._state.status !== 'disconnected') {
      await this.disconnect();
    }

    // Capture the pre-VPN default gateway so we can restore management-traffic
    // routing after redirect-gateway rewrites the routing table.
    this._savedGw = this._captureDefaultGateway();

    // Write credentials securely
    fs.writeFileSync(CREDS_FILE, `${username}\n${password}`, { mode: 0o600 });

    // Reset log
    try { fs.writeFileSync(LOG_FILE, ''); } catch (_) {}

    this._setState({
      status:   'connecting',
      endpoint: configFile.replace(/\.ovpn$/i, ''),
      error:    null,
    });

    return new Promise((resolve, reject) => {
      const proc = spawn('openvpn', [
        '--config',         configPath,
        '--auth-user-pass', CREDS_FILE,
        '--log',            LOG_FILE,
        '--writepid',       PID_FILE,
        '--verb',           '3',
        // Force ALL outbound traffic through the VPN tunnel so that Sky TG24 /
        // CDN requests exit with an Italian IP address.
        '--redirect-gateway', 'def1',
        // Keep local RFC-1918 networks routed via the original gateway so that
        // LAN traffic (192.168.0.0/16 and 10.0.0.0/8) bypasses the tunnel.
        '--route', '192.168.0.0', '255.255.0.0', 'net_gateway',  // /16
        '--route', '10.0.0.0',   '255.0.0.0',   'net_gateway',  // /8
        // Management-UI traffic (responses back to clients that connected via
        // the Docker bridge / eth0) is kept on eth0 by the policy-routing
        // rules set up in _setupPolicyRouting() once the tunnel is live.
      ], { stdio: 'pipe' });

      this._proc = proc;
      let settled = false;

      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(logWatcher);
        if (err) reject(err); else resolve();
      };

      // Timeout
      const timer = setTimeout(() => {
        this._setState({ status: 'error', error: 'Connection timed out' });
        settle(new Error('VPN connection timed out'));
        proc.kill('SIGTERM');
      }, CONNECT_TIMEOUT_MS);

      // Poll the OpenVPN log for success / auth-failure.
      // Use a local variable so settle() doesn't accidentally clear a watcher
      // belonging to a later connection attempt.
      const logWatcher = setInterval(() => {
        try {
          const log = fs.readFileSync(LOG_FILE, 'utf8');
          if (log.includes('Initialization Sequence Completed')) {
            this._setupPolicyRouting(this._savedGw);
            // Mark connected immediately; public IP is resolved asynchronously.
            this._setState({ status: 'connected', ip: null, connectedAt: new Date().toISOString() });
            settle(null);
            // Parse the tunnel IP now (synchronously) as a fallback before the
            // async public-IP request is dispatched.
            const tunnelIp = this._parseAssignedIp(log);
            // Fetch the actual public exit IP (traffic now travels through the
            // VPN tunnel, so this reflects the VPN server's external address).
            this._fetchPublicIp()
              .then(ip => {
                if (this._state.status === 'connected') this._setState({ ip });
              })
              .catch(() => {
                // Fall back to the tunnel interface IP parsed from the log.
                if (this._state.status === 'connected') this._setState({ ip: tunnelIp });
              });
          } else if (/AUTH_FAILED|auth-failure|incorrect password/i.test(log)) {
            this._setState({ status: 'error', error: 'Authentication failed' });
            settle(new Error('Authentication failed'));
            proc.kill('SIGTERM');
          }
        } catch (_) {}
      }, 500);
      // Keep the instance reference so disconnect() can cancel it too.
      this._logWatcher = logWatcher;

      proc.on('exit', () => {
        clearInterval(logWatcher);
        clearTimeout(timer);
        this._proc = null;
        this._cleanup();
        if (this._state.status !== 'error') {
          this._setState({ status: 'disconnected', ip: null, connectedAt: null });
        }
      });

      proc.on('error', (err) => {
        this._setState({ status: 'error', error: err.message });
        settle(err);
      });
    });
  }

  /** Terminate the VPN process */
  async disconnect() {
    clearInterval(this._logWatcher);
    this._logWatcher = null;

    this._teardownPolicyRouting(this._savedGw);
    this._savedGw = null;

    if (this._proc) {
      this._proc.kill('SIGTERM');
      this._proc = null;
    }

    // Also kill via pid-file if openvpn daemonized
    try {
      const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
      if (pid) process.kill(parseInt(pid, 10), 'SIGTERM');
    } catch (_) {}

    this._cleanup();
    this._setState({
      status:      'disconnected',
      ip:          null,
      connectedAt: null,
      endpoint:    null,
      error:       null,
    });
  }

  getStatus() {
    return { ...this._state };
  }

  // ── private helpers ──────────────────────────────────────────────────────

  _setState(updates) {
    this._state = { ...this._state, ...updates };
    this.emit('status', this._state);
  }

  _cleanup() {
    try { fs.unlinkSync(CREDS_FILE); } catch (_) {}
    try { fs.unlinkSync(PID_FILE);   } catch (_) {}
  }

  /** Read the current default gateway from the routing table (before VPN changes it) */
  _captureDefaultGateway() {
    try {
      const out = execFileSync('ip', ['route', 'show', 'default'], { encoding: 'utf8' });
      const m   = out.match(/default via ([\d.]+) dev (\S+)/);
      if (!m) return null;
      return { gateway: m[1], dev: m[2] };
    } catch {
      return null;
    }
  }

  /**
   * Install policy-routing rules so that connections established via the
   * Docker bridge (eth0) send their responses back through eth0, regardless
   * of the VPN's redirect-gateway routes.
   *
   * Without this, redirect-gateway adds 0/1 + 128/1 routes via tun0.  When a
   * management-UI client connects via the Docker-bridge port mapping, the
   * container's response to the client's real IP would be sent into the VPN
   * tunnel, breaking the connection asymmetrically.
   *
   * Fix: use iptables CONNMARK to tag every connection whose first packet
   * arrived on eth0, then use an `ip rule` to look up a secondary routing
   * table (table 100) for output packets bearing that mark.  Table 100 holds
   * the original default route via eth0's gateway.
   */
  _setupPolicyRouting(gw) {
    if (!gw) return;
    // Clean up any stale rules from a previous session first.
    this._teardownPolicyRouting(gw);
    const { gateway, dev } = gw;
    try {
      execFileSync('ip', ['route', 'replace', 'default', 'via', gateway, 'dev', dev, 'table', POLICY_ROUTE_TABLE]);
      execFileSync('ip', ['rule', 'add', 'fwmark', POLICY_ROUTE_FWMARK, 'lookup', POLICY_ROUTE_TABLE, 'priority', '100']);
      execFileSync('iptables', ['-t', 'mangle', '-A', 'PREROUTING', '-i', dev,
        '-j', 'CONNMARK', '--set-mark', POLICY_ROUTE_FWMARK]);
      execFileSync('iptables', ['-t', 'mangle', '-A', 'OUTPUT',
        '-m', 'connmark', '--mark', POLICY_ROUTE_FWMARK, '-j', 'MARK', '--set-mark', POLICY_ROUTE_FWMARK]);
      this._policyRouteActive = true;
    } catch (err) {
      console.warn('[VPN] Warning: could not set up policy routing:', err.message);
    }
  }

  /** Remove the policy-routing rules installed by _setupPolicyRouting */
  _teardownPolicyRouting(gw) {
    if (!this._policyRouteActive || !gw) return;
    this._policyRouteActive = false;
    const { gateway, dev } = gw;
    try { execFileSync('ip', ['rule', 'del', 'fwmark', POLICY_ROUTE_FWMARK, 'lookup', POLICY_ROUTE_TABLE, 'priority', '100']); } catch (_) {}
    try { execFileSync('ip', ['route', 'flush', 'table', POLICY_ROUTE_TABLE]); } catch (_) {}
    try {
      execFileSync('iptables', ['-t', 'mangle', '-D', 'PREROUTING', '-i', dev,
        '-j', 'CONNMARK', '--set-mark', POLICY_ROUTE_FWMARK]);
    } catch (_) {}
    try {
      execFileSync('iptables', ['-t', 'mangle', '-D', 'OUTPUT',
        '-m', 'connmark', '--mark', POLICY_ROUTE_FWMARK, '-j', 'MARK', '--set-mark', POLICY_ROUTE_FWMARK]);
    } catch (_) {}
  }

  /** Fetch the actual public exit IP by calling an external IP-echo service.
   *  Must be called after the VPN tunnel is live so the request travels through
   *  it and reflects the VPN server's external address rather than the host's.
   */
  _fetchPublicIp() {
    return new Promise((resolve, reject) => {
      const req = https.get('https://api.ipify.org?format=json', (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).ip);
          } catch {
            reject(new Error('Failed to parse public IP response'));
          }
        });
      });
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Public IP request timed out')); });
      req.on('error', reject);
    });
  }

  _parseAssignedIp(log) {
    // Look for lines like: ifconfig 10.x.x.x 255.x.x.x   OR   /sbin/ip addr add 10.x.x.x/...
    const m = log.match(/ifconfig\s+([\d.]+)\s+[\d.]+/)
           || log.match(/ip addr add ([\d.]+)\//);
    return m ? m[1] : null;
  }
}

module.exports = VPNManager;
