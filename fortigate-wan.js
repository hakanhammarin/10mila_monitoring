// fortigate-wan.js — reads one WAN interface on a FortiGate over the FortiOS REST API (read-only API admin).
// The same file is in monitoring_js and statistics_js.
//
// The API key goes in an "Authorization: Bearer" header, never in the url, so it is not written to any log.
// Config: { url: "https://192.168.1.99", apiKey, interface: "wan1", vdom: "root", caFile }
//   caFile (optional): the FortiGate's own certificate (PEM). With it the TLS connection is verified against
//   that certificate; without it the self-signed certificate is accepted and a warning is logged once.
//
// read() returns:
//   { interface, link, speed, duplex, rx_bytes, tx_bytes, rx_packets, tx_packets, rx_errors, tx_errors,
//     rx_mbps, tx_mbps,                         // from the byte counters since the previous read (null the first time)
//     health: [ { name, status, latency, jitter, packet_loss } ] }   // SD-WAN health checks on this interface, if any
const axios = require('axios');
const https = require('https');
const fs = require('fs');

class FortigateWan {
    constructor(config, timeoutMs = 5000) {
        if (!config || !config.url || !config.apiKey) throw new Error('FortiGate: url and apiKey are required');
        this.base = String(config.url).replace(/\/+$/, '');
        this.iface = config.interface || 'wan1';
        this.vdom = config.vdom || 'root';
        this.timeout = timeoutMs;
        if (config.caFile) {
            // Trust exactly this certificate. The certificate names the FortiGate's serial, not its address,
            // so the host name check is skipped: the pinned certificate is the identity.
            this.agent = new https.Agent({ ca: fs.readFileSync(config.caFile), rejectUnauthorized: true, checkServerIdentity: () => undefined });
        } else {
            this.agent = new https.Agent({ rejectUnauthorized: false });
            console.warn(`FortiGate ${this.base}: no caFile, the certificate is not verified`);
        }
        this.headers = { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' };
        this.path = null;   // FortiOS 6.x/7.0-7.2 use .../interface/select, 7.4+ .../interface
        this.prev = null;   // previous counters, for Mbit/s
    }

    async get(p, params = {}) {
        const r = await axios.get(this.base + p, {
            httpsAgent: this.agent, timeout: this.timeout, headers: this.headers,
            params: { vdom: this.vdom, ...params }
        });
        return r.data;
    }

    async readInterface() {
        const params = { interface_name: this.iface };
        const paths = this.path ? [this.path] : ['/api/v2/monitor/system/interface/select', '/api/v2/monitor/system/interface'];
        let lastErr;
        for (const p of paths) {
            try {
                const data = await this.get(p, params);
                this.path = p;
                const res = data && data.results;
                const i = res && (res[this.iface] || (Array.isArray(res) ? res.find(x => x.name === this.iface) : null));
                if (!i) throw new Error(`interface ${this.iface} not found`);
                return i;
            } catch (e) {
                lastErr = e;
                if (!(e.response && e.response.status === 404)) break;   // 404: try the other path
            }
        }
        throw lastErr;
    }

    async readHealth() {
        // SD-WAN performance SLA: { "<health check>": { "<interface>": { status, latency, jitter, packet_loss } } }
        try {
            const data = await this.get('/api/v2/monitor/virtual-wan/health-check');
            const out = [];
            for (const [name, members] of Object.entries((data && data.results) || {})) {
                const m = members && members[this.iface];
                if (m) out.push({ name, status: m.status, latency: num(m.latency), jitter: num(m.jitter), packet_loss: num(m.packet_loss) });
            }
            return out;
        } catch {
            return [];   // no SD-WAN, or the profile cannot read it: not an error for the interface
        }
    }

    async read() {
        const [i, health] = await Promise.all([this.readInterface(), this.readHealth()]);
        const now = Date.now();
        const cur = { t: now, rx: Number(i.rx_bytes) || 0, tx: Number(i.tx_bytes) || 0 };
        let rx_mbps = null, tx_mbps = null;
        if (this.prev && cur.t > this.prev.t && cur.rx >= this.prev.rx && cur.tx >= this.prev.tx) {
            const s = (cur.t - this.prev.t) / 1000;
            rx_mbps = round((cur.rx - this.prev.rx) * 8 / s / 1e6);
            tx_mbps = round((cur.tx - this.prev.tx) * 8 / s / 1e6);
        }
        this.prev = cur;
        return {
            interface: this.iface,
            link: i.link === true || i.link === 'up',
            speed: i.speed ?? null,
            duplex: i.duplex ?? null,
            rx_bytes: cur.rx, tx_bytes: cur.tx,
            rx_packets: i.rx_packets ?? null, tx_packets: i.tx_packets ?? null,
            rx_errors: i.rx_errors ?? null, tx_errors: i.tx_errors ?? null,
            rx_mbps, tx_mbps,
            health
        };
    }
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? round(n) : null; }
function round(n) { return Math.round(n * 100) / 100; }

module.exports = FortigateWan;
