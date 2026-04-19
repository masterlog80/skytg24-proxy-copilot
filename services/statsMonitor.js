'use strict';

const fs   = require('fs');
const path = require('path');

const VPN_TRAFFIC_FILE = process.env.VPN_TRAFFIC_FILE || '/config/vpn-traffic.json';

class StatsMonitor {
  constructor() {
    this._prev          = {};
    this._prevTime      = Date.now();
    this._vpnPrevBytes  = null;  // { rxBytes, txBytes } snapshot for delta
    this._vpnAccumRx    = 0;
    this._vpnAccumTx    = 0;
    this._lastPersist   = 0;     // timestamp of last disk write
    this._loadVpnTraffic();
  }

  /** Reset accumulated VPN traffic counters and persist to disk */
  resetVpnTraffic() {
    this._vpnAccumRx   = 0;
    this._vpnAccumTx   = 0;
    this._vpnPrevBytes = null;
    this._persistVpnTraffic();
  }

  // ── private helpers ────────────────────────────────────────────────────────

  _loadVpnTraffic() {
    try {
      const raw = fs.readFileSync(VPN_TRAFFIC_FILE, 'utf8');
      const data = JSON.parse(raw);
      this._vpnAccumRx = Number(data.vpnAccumRx) || 0;
      this._vpnAccumTx = Number(data.vpnAccumTx) || 0;
    } catch {
      // File missing or invalid – start from zero
    }
  }

  _persistVpnTraffic() {
    try {
      fs.mkdirSync(path.dirname(VPN_TRAFFIC_FILE), { recursive: true });
      const tmp = `${VPN_TRAFFIC_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ vpnAccumRx: this._vpnAccumRx, vpnAccumTx: this._vpnAccumTx }), { mode: 0o600 });
      try {
        fs.renameSync(tmp, VPN_TRAFFIC_FILE);
      } catch (renameErr) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw renameErr;
      }
    } catch (err) {
      console.error('StatsMonitor: failed to persist VPN traffic:', err.message);
    }
  }

  async getStats() {
    try {
      const raw  = fs.readFileSync('/proc/net/dev', 'utf8');
      const now  = Date.now();
      const elapsed = Math.max((now - this._prevTime) / 1000, 0.1);
      const ifaces = {};

      for (const line of raw.split('\n')) {
        // Format: iface: rxBytes rxPkts rxErr rxDrop rxFifo rxFrame rxComp rxMcast
        //                txBytes txPkts txErr txDrop txFifo txColls txCarr txComp
        const m = line.match(
          /^\s*(\w+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/
        );
        if (!m) continue;
        const [, name, rxB, txB] = m;
        const rxBytes = parseInt(rxB, 10);
        const txBytes = parseInt(txB, 10);
        const prev    = this._prev[name];

        ifaces[name] = {
          rxBytes,
          txBytes,
          rxRate: prev ? Math.max(0, (rxBytes - prev.rxBytes) / elapsed) : 0,
          txRate: prev ? Math.max(0, (txBytes - prev.txBytes) / elapsed) : 0,
        };
      }

      this._prev = Object.fromEntries(
        Object.entries(ifaces).map(([k, v]) => [k, { rxBytes: v.rxBytes, txBytes: v.txBytes }])
      );
      this._prevTime = now;

      // Pick VPN interface (tun0, tun1, …) and primary eth
      const vpn = ifaces['tun0'] || ifaces['tun1'] || null;
      const eth = ifaces['eth0'] || ifaces['eth1'] || ifaces['ens3'] || ifaces['ens4'] || null;

      // Accumulate VPN traffic for persistent counters
      if (vpn) {
        if (this._vpnPrevBytes) {
          const deltaRx = vpn.rxBytes - this._vpnPrevBytes.rxBytes;
          const deltaTx = vpn.txBytes - this._vpnPrevBytes.txBytes;
          // Only add positive deltas (negative means interface reset)
          if (deltaRx > 0) this._vpnAccumRx += deltaRx;
          if (deltaTx > 0) this._vpnAccumTx += deltaTx;
          // Throttle disk writes to at most once every 30 seconds
          if ((deltaRx > 0 || deltaTx > 0) && now - this._lastPersist >= 30_000) {
            this._persistVpnTraffic();
            this._lastPersist = now;
          }
        }
        this._vpnPrevBytes = { rxBytes: vpn.rxBytes, txBytes: vpn.txBytes };
      } else {
        // VPN interface gone – flush any un-persisted accumulator and reset snapshot
        if (this._vpnPrevBytes && this._lastPersist < this._prevTime) {
          this._persistVpnTraffic();
          this._lastPersist = now;
        }
        this._vpnPrevBytes = null;
      }

      return { ifaces, vpn, eth, vpnTotalRx: this._vpnAccumRx, vpnTotalTx: this._vpnAccumTx, ts: now };
    } catch (err) {
      return { ifaces: {}, vpn: null, eth: null, vpnTotalRx: this._vpnAccumRx, vpnTotalTx: this._vpnAccumTx, error: err.message, ts: Date.now() };
    }
  }
}

module.exports = StatsMonitor;
