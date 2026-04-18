'use strict';

const { spawn }      = require('child_process');
const EventEmitter   = require('events');
const fs             = require('fs');
const path           = require('path');

const VPN_CONFIG_DIR = process.env.VPN_CONFIG_DIR || path.join(__dirname, '..', 'config', 'vpn');
const CREDS_FILE     = '/tmp/.vpn_creds';
const LOG_FILE       = '/tmp/openvpn.log';
const PID_FILE       = '/tmp/openvpn.pid';
const CONNECT_TIMEOUT_MS = 90_000;

class VPNManager extends EventEmitter {
  constructor() {
    super();
    this._proc       = null;
    this._logWatcher = null;
    this._state      = {
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

  /** Connect using a named .ovpn file and plaintext credentials */
  connect(configFile, username, password) {
    // Sanitise: must be a plain filename, not a path
    if (path.basename(configFile) !== configFile) {
      return Promise.reject(new Error('Invalid config filename'));
    }
    const configPath = path.join(VPN_CONFIG_DIR, configFile);
    if (!fs.existsSync(configPath)) {
      return Promise.reject(new Error(`Config file not found: ${configFile}`));
    }

    const doConnect = async () => {
      // Kill any existing connection first
      if (this._state.status !== 'disconnected') {
        await this.disconnect();
      }

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
          '--config',        configPath,
          '--auth-user-pass', CREDS_FILE,
          '--log',            LOG_FILE,
          '--writepid',       PID_FILE,
          '--verb',           '3',
        ], { stdio: 'pipe' });

        this._proc = proc;
        let settled = false;

        const settle = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(this._logWatcher);
          if (err) reject(err); else resolve();
        };

        // Timeout
        const timer = setTimeout(() => {
          this._setState({ status: 'error', error: 'Connection timed out' });
          settle(new Error('VPN connection timed out'));
          proc.kill('SIGTERM');
        }, CONNECT_TIMEOUT_MS);

        // Poll the OpenVPN log for success / auth-failure
        this._logWatcher = setInterval(() => {
          try {
            const log = fs.readFileSync(LOG_FILE, 'utf8');
            if (log.includes('Initialization Sequence Completed')) {
              const ip = this._parseAssignedIp(log);
              this._setState({ status: 'connected', ip, connectedAt: new Date().toISOString() });
              settle(null);
            } else if (/AUTH_FAILED|auth-failure|incorrect password/i.test(log)) {
              this._setState({ status: 'error', error: 'Authentication failed' });
              settle(new Error('Authentication failed'));
              proc.kill('SIGTERM');
            }
          } catch (_) {}
        }, 500);

        proc.on('exit', () => {
          clearInterval(this._logWatcher);
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
    };

    return doConnect();
  }

  /** Terminate the VPN process */
  async disconnect() {
    clearInterval(this._logWatcher);
    this._logWatcher = null;

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

  _parseAssignedIp(log) {
    // Look for lines like: ifconfig 10.x.x.x 255.x.x.x   OR   /sbin/ip addr add 10.x.x.x/...
    const m = log.match(/ifconfig\s+([\d.]+)\s+[\d.]+/)
           || log.match(/ip addr add ([\d.]+)\//);
    return m ? m[1] : null;
  }
}

module.exports = VPNManager;
