'use strict';

const fs = require('fs');

class StatsMonitor {
  constructor() {
    this._prev     = {};
    this._prevTime = Date.now();
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

      return { ifaces, vpn, eth, ts: now };
    } catch (err) {
      return { ifaces: {}, vpn: null, eth: null, error: err.message, ts: Date.now() };
    }
  }
}

module.exports = StatsMonitor;
