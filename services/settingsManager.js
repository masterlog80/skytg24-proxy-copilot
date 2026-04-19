'use strict';

const fs   = require('fs');
const path = require('path');

const SETTINGS_FILE = process.env.SETTINGS_FILE || '/config/settings.json';

const DEFAULTS = {
  vpnEndpoint:              '',
  vpnUsername:              '',
  vpnPassword:              '',
  streamPort:               6443,
  streamUrl:                '',
  streamFallbackUrl:        '',
  fetchTargetUrl:           '',
  fetchSearchString:        '',
  fetchMaxAttempts:         0,
  fetchRetryDelaySec:       0,
  fetchLiveUrlEnabled:      true, // when false, skip auto-detection and use fallback URL immediately
  vpnDisconnectTimeoutMin:  5,  // minutes before VPN is disconnected when no clients remain; 0 = disabled
};

class SettingsManager {
  constructor() {
    this._file = SETTINGS_FILE;
    this._data = this._load();
  }

  /** Return a copy of the current settings */
  get() {
    return { ...this._data };
  }

  /** Merge *updates* into settings, persist to disk and return the new state.
   *  Only keys present in DEFAULTS are accepted; unknown keys are ignored.
   */
  save(updates) {
    const filtered = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (key in updates) filtered[key] = updates[key];
    }
    this._data = { ...this._data, ...filtered };
    this._persist();
    return { ...this._data };
  }

  // ── private ────────────────────────────────────────────────────────────────

  _load() {
    try {
      const raw = fs.readFileSync(this._file, 'utf8');
      return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      // Atomic write: write to a temp file then rename to avoid partial reads
      const tmp = `${this._file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), { mode: 0o600 });
      try {
        fs.renameSync(tmp, this._file);
      } catch (renameErr) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw renameErr;
      }
    } catch (err) {
      console.error('SettingsManager: failed to persist settings:', err.message);
    }
  }
}

module.exports = SettingsManager;
