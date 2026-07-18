const multicastDns = require('multicast-dns');
const axios = require('axios');
const fs = require('fs').promises;
const crypto = require('crypto');

class PowerlossDiscovery {
    constructor(settings) {
        this.settings = settings;
        this.agents = new Map(); // key: service instance name
        this.mdns = null;
        this.queryInterval = null;
        this.probeInterval = null;
        this.isRunning = false;
        this.cisFile = settings.paths.cisDiscovery;
    }

    async start() {
        const cfg = this.settings.mdns;
        if (!cfg?.enabled) {
            console.log('[mDNS] PowerLoss discovery disabled');
            return;
        }

        await this._loadFromCis();
        await this._probeAll();

        const serviceType = cfg.serviceType || 'powerloss';
        this.ptrName = `_${serviceType}._tcp.local`;

        this.mdns = multicastDns();
        this.mdns.on('response', (packet, rinfo) => this._handleResponse(packet, rinfo));

        // 1.5 s startup delay so the UDP socket is ready before first query
        setTimeout(() => this._sendQuery(), 1500);
        // Repeat every 60 s — grandcat/zeroconf rate-limits responses per RFC 6762 §6
        this.queryInterval = setInterval(() => this._sendQuery(), 60000);

        const probeMs = (cfg.probeInterval || 30) * 1000;
        this.probeInterval = setInterval(() => this._probeAll(), probeMs);

        this.isRunning = true;
        console.log(`[mDNS] Browsing for ${this.ptrName}`);
    }

    _sendQuery() {
        if (this.mdns) {
            this.mdns.query({ questions: [{ name: this.ptrName, type: 'PTR' }] });
        }
    }

    _handleResponse(packet, rinfo) {
        const all = [...packet.answers, ...packet.additionals];
        const ptrs = all.filter(a => a.type === 'PTR' && a.name === this.ptrName);

        for (const ptr of ptrs) {
            const instanceName = ptr.data;
            const serviceId = instanceName.replace(/\._[^.]+\._tcp\.local\.?$/, '');

            const srv = all.find(a => a.type === 'SRV' && a.name === instanceName);
            if (!srv) continue;

            const port = srv.data.port;
            const host = srv.data.target.replace(/\.$/, '');

            const aRec = all.find(a => a.type === 'A');
            const ip = aRec ? aRec.data : rinfo.address;

            const txtRec = all.find(a => a.type === 'TXT' && a.name === instanceName);
            const txt = this._parseTxt(txtRec);

            console.log(`[mDNS] Found: ${serviceId} @ ${ip}:${port}`);
            this._probeService({ name: serviceId, host, port, ip, txt });
        }
    }

    _parseTxt(txtRec) {
        if (!txtRec || !Array.isArray(txtRec.data)) return {};
        const out = {};
        for (const entry of txtRec.data) {
            const str = Buffer.isBuffer(entry) ? entry.toString() :
                        (entry?.data ? Buffer.from(entry.data).toString() : String(entry));
            const eq = str.indexOf('=');
            if (eq > 0) out[str.slice(0, eq)] = str.slice(eq + 1);
        }
        return out;
    }

    async _probeService({ name, host, port, ip, txt }) {
        const url = `http://${ip}:${port}/api/status`;
        try {
            const { data } = await axios.get(url, { timeout: 5000 });
            const existing = this.agents.get(name) || {};
            const agent = {
                id: name,
                host,
                ip,
                port,
                online: true,
                discoveredVia: 'mdns',
                lastProbed: new Date().toISOString(),
                computer_name: data.computer_name,
                location: data.location,
                is_charging: data.is_charging,
                soc: data.soc,
                ip_addresses: (data.ip_addresses || []).filter(a => !a.startsWith('169.254.')),
                agent_timestamp: data.timestamp,
                txt: txt || {},
                _cisIndex: existing._cisIndex // preserve existing UUID
            };
            this.agents.set(name, agent);
            await this._saveToCis();
            console.log(`[mDNS] ${name}: SOC=${data.soc}% charging=${data.is_charging}`);
        } catch (err) {
            console.log(`[mDNS] Probe failed ${name} @ ${url}: ${err.message}`);
            if (this.agents.has(name)) {
                this.agents.get(name).online = false;
                await this._saveToCis();
            }
        }
    }

    async _probeAll() {
        for (const agent of this.agents.values()) {
            if (agent.ip) await this._probeService(agent);
        }
    }

    getAgents() {
        return Array.from(this.agents.values());
    }

    // Load previously discovered mDNS agents from cis_discovery.json
    async _loadFromCis() {
        try {
            const data = await fs.readFile(this.cisFile, 'utf8');
            const all = JSON.parse(data);
            const mdnsEntries = all.filter(d => d.source === 'mdns');
            mdnsEntries.forEach(d => {
                const match = d.ip.match(/^https?:\/\/(.+):(\d+)/);
                if (!match) return;
                this.agents.set(d.name, {
                    id: d.name,
                    ip: match[1],
                    port: parseInt(match[2]),
                    host: d.rawData?.host || '',
                    online: false,
                    discoveredVia: 'mdns',
                    lastProbed: d.lastDiscovered || '',
                    computer_name: d.rawData?.computer_name,
                    location: d.rawData?.location,
                    is_charging: d.rawData?.is_charging,
                    soc: d.rawData?.soc,
                    ip_addresses: d.rawData?.ip_addresses,
                    txt: d.rawData?.txt || {},
                    _cisIndex: d.index
                });
            });
            if (this.agents.size > 0) {
                console.log(`[mDNS] Loaded ${this.agents.size} known PowerLoss agent(s) from cis_discovery.json`);
            }
        } catch {
            // File doesn't exist yet — start fresh
        }
    }

    // Merge in-memory agents into cis_discovery.json alongside Fortigate entries
    async _saveToCis() {
        try {
            let existing = [];
            try {
                existing = JSON.parse(await fs.readFile(this.cisFile, 'utf8'));
            } catch {}

            // Build map keyed by ip field (raw IPs for Fortigate, http URLs for mDNS)
            const entryMap = new Map(existing.map(d => [d.ip, d]));

            for (const agent of this.agents.values()) {
                const cisIp = `http://${agent.ip}:${agent.port}`;
                const prev = entryMap.get(cisIp);
                const index = agent._cisIndex || prev?.index || crypto.randomUUID();

                // Persist the UUID back onto the agent so it's stable on next save
                agent._cisIndex = index;

                entryMap.set(cisIp, {
                    index,
                    type: 'powerloss',
                    ip: cisIp,
                    name: agent.computer_name || agent.id,
                    status: '0',
                    time: '',
                    rtt: 0,
                    count: 0,
                    downtime: '',
                    discovered: agent.lastProbed,
                    source: 'mdns',
                    rawData: {
                        computer_name: agent.computer_name,
                        location: agent.location,
                        soc: agent.soc,
                        is_charging: agent.is_charging,
                        ip_addresses: agent.ip_addresses,
                        txt: agent.txt
                    },
                    firstDiscovered: prev?.firstDiscovered || agent.lastProbed,
                    lastDiscovered: agent.lastProbed
                });
            }

            await fs.writeFile(
                this.cisFile,
                JSON.stringify(Array.from(entryMap.values()), null, 4)
            );
            console.log(`[mDNS] Merged ${this.agents.size} PowerLoss agent(s) into cis_discovery.json`);
        } catch (err) {
            console.error('[mDNS] Failed to update cis_discovery.json:', err.message);
        }
    }

    stop() {
        if (this.queryInterval) clearInterval(this.queryInterval);
        if (this.probeInterval) clearInterval(this.probeInterval);
        if (this.mdns) this.mdns.destroy();
        this.isRunning = false;
        console.log('[mDNS] PowerLoss discovery stopped');
    }
}

module.exports = PowerlossDiscovery;
