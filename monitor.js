const fs = require('fs').promises;
const ping = require('ping');
const axios = require('axios');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

class NetworkMonitor {
    constructor(settings) {
        this.settings = settings;
        this.cisData = [];
        this.cisDataCounter = new Map(); // Map of GUID -> counter data
        this.isRunning = false;

        // Create axios instance with SSL verification disabled for FUEL API
        this.httpsAgent = new https.Agent({
            rejectUnauthorized: false
        });
    }

    // Generate a new GUID (UUID v4)
    generateGuid() {
        return crypto.randomUUID();
    }

    // Validate and fix GUIDs in the CIS configuration
    // If savePath is provided, saves the array to that file if modified
    // If savePath is null, validation occurs but no file is saved
    async validateAndFixGuids(cisArray, savePath = null) {
        const seenGuids = new Set();
        let modified = false;

        for (let i = 0; i < cisArray.length; i++) {
            const ci = cisArray[i];
            const isNumeric = typeof ci.index === 'number';
            const isEmpty = !ci.index || ci.index === '';
            const isDuplicate = seenGuids.has(ci.index);

            // Check if index is missing, empty, numeric, or duplicate
            if (isEmpty || isNumeric || isDuplicate) {
                const oldIndex = ci.index || '(empty)';
                ci.index = this.generateGuid();

                let reason = '';
                if (isEmpty) reason = 'empty';
                else if (isNumeric) reason = 'numeric';
                else if (isDuplicate) reason = 'duplicate';

                console.log(`⚠ CI "${ci.name}": Generated new GUID for ${reason} index`);
                console.log(`  Old: ${oldIndex} → New: ${ci.index}`);
                modified = true;
            }

            seenGuids.add(ci.index);
        }

        // If we modified any GUIDs and a save path was provided, save the updated configuration
        if (modified && savePath) {
            try {
                await fs.writeFile(
                    savePath,
                    JSON.stringify(cisArray, null, 4)
                );
                console.log(`✓ Updated ${path.basename(savePath)} with new GUIDs\n`);
            } catch (error) {
                console.error(`Error saving updated ${path.basename(savePath)}:`, error);
            }
        }

        return cisArray;
    }

    async initialize() {
        try {
            let combinedArray = [];

            // Check if baseline mode is enabled
            if (this.settings.baseline.enabled) {
                console.log('📊 Baseline mode ENABLED');

                // Load from baseline file
                try {
                    const baselineJson = await fs.readFile(this.settings.paths.cisBaseline, 'utf8');
                    combinedArray = JSON.parse(baselineJson);
                    console.log(`Loaded ${combinedArray.length} CIs from baseline (created: ${this.settings.baseline.createdAt})`);
                } catch (error) {
                    console.error('Error loading baseline:', error.message);
                    console.log('⚠ Baseline file not found. Falling back to normal mode.');
                    this.settings.baseline.enabled = false;
                }
            }

            // Normal mode - load static + discovered devices
            if (!this.settings.baseline.enabled) {
                console.log('📡 Normal mode - monitoring all devices');

                // Load and validate static CIS configuration
                const cisJson = await fs.readFile(this.settings.paths.cisConfig, 'utf8');
                let cisArray = JSON.parse(cisJson);

                console.log(`Loaded ${cisArray.length} CIs from static configuration`);

                // Validate static devices and save to cis.json if needed
                cisArray = await this.validateAndFixGuids(cisArray, this.settings.paths.cisConfig);

                // Load discovered devices if file exists
                let discoveredArray = [];
                try {
                    const discoveryJson = await fs.readFile(this.settings.paths.cisDiscovery, 'utf8');
                    discoveredArray = JSON.parse(discoveryJson);
                    console.log(`Loaded ${discoveredArray.length} CIs from discovery`);

                    // Validate discovered devices and save to cis_discovery.json if needed
                    discoveredArray = await this.validateAndFixGuids(discoveredArray, this.settings.paths.cisDiscovery);
                } catch (error) {
                    console.log('No discovered devices found (this is normal on first run)');
                }

                // Build a set of IPs already defined in static cis.json
                const staticIps = new Set(cisArray.map(ci => ci.ip));

                // Filter discovered devices: skip any IP already covered by a static entry
                // so cis.json name/group always wins — no duplicates
                const uniqueDiscovered = discoveredArray.filter(d => !staticIps.has(d.ip));
                const skipped = discoveredArray.length - uniqueDiscovered.length;
                if (skipped > 0) {
                    console.log(`↳ Skipped ${skipped} discovered device(s) already defined in cis.json`);
                }

                // Combine static and (deduplicated) discovered devices
                combinedArray = [...cisArray, ...uniqueDiscovered];
                console.log(`Total CIs to monitor: ${combinedArray.length}`);
            } else {
                // Baseline mode - just validate without saving
                combinedArray = await this.validateAndFixGuids(combinedArray, null);
            }

            // Store validated data
            const validatedArray = combinedArray;

            // Store validated data
            this.cisData = validatedArray;

            // Create counter map indexed by GUID
            this.cisDataCounter.clear();
            validatedArray.forEach(ci => {
                this.cisDataCounter.set(ci.index, {
                    count: ci.count || 0,
                    downtime: ci.downtime || '',
                    status: ci.status
                });
            });

            // Ensure result directory exists
            const resultDir = path.dirname(this.settings.paths.resultJson);
            await fs.mkdir(resultDir, { recursive: true });

            // Ensure logs directory exists
            await fs.mkdir(this.settings.paths.logsDir, { recursive: true });

            return true;
        } catch (error) {
            console.error('Error initializing monitor:', error);
            return false;
        }
    }

    // Reload configuration (useful after discovery runs)
    async reloadConfiguration() {
        console.log('Reloading configuration...');
        return await this.initialize();
    }

    async checkNginx(ci) {
        const now = this.getTimestamp();
        const counter = this.cisDataCounter.get(ci.index);
        ci.time = now;

        try {
            const response = await axios.get(ci.ip, {
                timeout: this.settings.timers.pingTimeout,
                responseType: 'text'
            });

            const body = response.data;

            // Parse: "Active connections: N"
            const activeMatch = body.match(/Active connections:\s*(\d+)/);
            // Parse: "Waiting: N"
            const waitingMatch = body.match(/Waiting:\s*(\d+)/);

            const active  = activeMatch  ? parseInt(activeMatch[1])  : 0;
            const waiting = waitingMatch ? parseInt(waitingMatch[1]) : 0;

            ci.rtt = `Active: ${active}  Waiting: ${waiting}`;

            if (waiting > 100) {
                if (counter.count === this.settings.thresholds.downThreshold) {
                    counter.downtime = now;
                }
                ci.status  = '40'; // Red
                counter.count++;
                ci.downtime = counter.downtime;
                ci.count    = counter.count;
            } else if (waiting > 50) {
                ci.status  = '20'; // Yellow
                ci.count   = 0;
                counter.count = 0;
            } else {
                ci.status  = '10'; // Green
                ci.count   = 0;
                counter.count = 0;
            }
        } catch (error) {
            console.error(`Error checking Nginx for ${ci.name}:`, error.message);
            ci.status = '40';
            ci.rtt    = 'Error';
        }
    }

    async checkPhpFpm(ci) {
        const now = this.getTimestamp();
        const counter = this.cisDataCounter.get(ci.index);
        ci.time = now;

        try {
            const url = ci.ip.includes('?') ? ci.ip : `${ci.ip}?json`;
            const response = await axios.get(url, {
                timeout: this.settings.timers.pingTimeout,
                headers: { Accept: 'application/json' }
            });

            const data = response.data;
            const maxChildrenReached = data['max children reached'] ?? 0;
            const slowRequests       = data['slow requests']        ?? 0;
            const activeProcesses    = data['active processes']     ?? 0;

            // Detect increases since last poll using stored previous values
            const prevMaxChildren = counter.prevMaxChildren ?? maxChildrenReached;
            const prevSlowReq     = counter.prevSlowReq     ?? slowRequests;

            const maxChildrenDelta = maxChildrenReached - prevMaxChildren;
            const slowReqDelta     = slowRequests       - prevSlowReq;

            counter.prevMaxChildren = maxChildrenReached;
            counter.prevSlowReq     = slowRequests;

            ci.rtt = `Active: ${activeProcesses}  MaxChReached: ${maxChildrenReached}  SlowReq: ${slowRequests}`;

            if (maxChildrenDelta > 0) {
                // Pool was exhausted — requests had to wait or be dropped
                if (counter.count === this.settings.thresholds.downThreshold) {
                    counter.downtime = now;
                }
                ci.status  = '40'; // Red
                counter.count++;
                ci.downtime = counter.downtime;
                ci.count    = counter.count;
            } else if (slowReqDelta > 0) {
                // Slow scripts detected
                ci.status  = '20'; // Yellow
                ci.count   = 0;
                counter.count = 0;
            } else {
                ci.status  = '10'; // Green
                ci.count   = 0;
                counter.count = 0;
            }
        } catch (error) {
            console.error(`Error checking PHP-FPM for ${ci.name}:`, error.message);
            ci.status = '40';
            ci.rtt    = 'Error';
        }
    }

    async checkDiskSpace(ci) {
        const now = this.getTimestamp();
        const counter = this.cisDataCounter.get(ci.index);
        ci.time = now;

        try {
            const response = await axios.get(ci.ip, {
                timeout: this.settings.timers.pingTimeout
            });

            const data = response.data;
            const diskSvc = data.services && data.services.disk_space;

            if (!diskSvc || !diskSvc.available || !diskSvc.mounts || diskSvc.mounts.length === 0) {
                ci.status = '40';
                ci.rtt = 'No disk data';
                return;
            }

            // Find the mount we're interested in (default: root /, or ci.mountKey)
            const mountKey = ci.mountKey || '/';
            const mount = diskSvc.mounts.find(m => m.mounted_on === mountKey);

            if (!mount) {
                ci.status = '40';
                ci.rtt = `Mount "${mountKey}" not found`;
                return;
            }

            const usePct = parseFloat(mount.use_pct);
            ci.rtt = `${mount.mounted_on}: ${mount.used}/${mount.size} (${mount.use_pct}%)`;

            const warningPct = ci.warningThreshold || 75;
            const criticalPct = ci.criticalThreshold || 90;

            if (usePct >= criticalPct) {
                if (counter.count === this.settings.thresholds.downThreshold) {
                    counter.downtime = now;
                }
                ci.status = '40';
                counter.count++;
                ci.downtime = counter.downtime;
                ci.count = counter.count;
            } else if (usePct >= warningPct) {
                ci.status = '20';
                ci.count = 0;
                counter.count = 0;
            } else {
                ci.status = '10';
                ci.count = 0;
                counter.count = 0;
            }
        } catch (error) {
            console.error(`Error checking disk space for ${ci.name}:`, error.message);
            ci.status = '40';
            ci.rtt = 'Error';
        }
    }

    async checkServicesJson(ci) {
        const now = this.getTimestamp();
        const counter = this.cisDataCounter.get(ci.index);
        ci.time = now;

        try {
            const response = await axios.get(ci.ip, {
                timeout: this.settings.timers.pingTimeout
            });

            const data = response.data;
            const svc = data.services && data.services[ci.serviceKey];

            if (!svc) {
                ci.status = '40';
                ci.rtt = 'Service not found in response';
                return;
            }

            // Build metrics display
            const parts = [];
            if (svc.cpu_pct      !== undefined) parts.push(`CPU: ${svc.cpu_pct}%`);
            if (svc.mem_mb       !== undefined) parts.push(`Mem: ${svc.mem_mb}MB`);
            if (svc.qps          !== undefined) parts.push(`QPS: ${svc.qps}`);
            if (svc.connections  !== undefined) parts.push(`Conn: ${svc.connections}`);
            if (svc.db_available !== undefined) parts.push(`DB: ${svc.db_available}`);
            if (svc.process_running  !== undefined) parts.push(`Proc: ${svc.process_running}`);
            if (svc.monitor_port     !== undefined) parts.push(`Port: ${svc.monitor_port}`);
            if (svc.monitor_port_ok  !== undefined) parts.push(`PortOK: ${svc.monitor_port_ok}`);
            ci.rtt = parts.join('  ');

            const isDown = !svc.available || svc.db_available === false;

            if (isDown) {
                if (counter.count === this.settings.thresholds.downThreshold) {
                    counter.downtime = now;
                }
                ci.status = '40';
                counter.count++;
                ci.downtime = counter.downtime;
                ci.count    = counter.count;
            } else {
                ci.status = '10';
                ci.count  = 0;
                counter.count = 0;
            }
        } catch (error) {
            console.error(`Error checking services_json for ${ci.name}:`, error.message);
            ci.status = '40';
            ci.rtt    = 'Error';
        }
    }

    async checkPowerLoss(ci) {
        const now = this.getTimestamp();
        const counter = this.cisDataCounter.get(ci.index);
        ci.time = now;

        try {
            ci._monitorUrl = ci._monitorUrl || ci.ip;
            const baseUrl = ci._monitorUrl.replace(/\/+$/, '');
            const url = baseUrl.endsWith('/api/status') ? baseUrl : `${baseUrl}/api/status`;
            const response = await axios.get(url, {
                timeout: this.settings.timers.pingTimeout
            });

            const data = response.data;
            const computerName = data.computer_name || ci.name;
            const location = data.location || '';
            const ipAddrs = Array.isArray(data.ip_addresses)
                ? data.ip_addresses.filter(a => !a.startsWith('169.254.')).join(', ')
                : '';
            const charging = data.is_charging === true;
            const soc = data.soc ?? 0;

            ci.ip = `${computerName}${location ? ` @ ${location}` : ''}${ipAddrs ? ` [${ipAddrs}]` : ''}`;
            ci.rtt = `SOC: ${soc}%  ${charging ? '⚡ Charging' : '🔋 On Battery'}`;

            if (!charging) {
                if (counter.count === this.settings.thresholds.downThreshold) {
                    counter.downtime = now;
                }
                ci.status = '40';
                counter.count++;
                ci.downtime = counter.downtime;
                ci.count = counter.count;
            } else {
                const criticalLevel = this.settings.thresholds.powerlossCriticalLevel ?? 10;
                if (soc <= criticalLevel) {
                    if (counter.count === this.settings.thresholds.downThreshold) {
                        counter.downtime = now;
                    }
                    ci.status = '40';
                    counter.count++;
                    ci.downtime = counter.downtime;
                    ci.count = counter.count;
                } else {
                    ci.status = '10';
                    ci.count = 0;
                    counter.count = 0;
                }
            }
        } catch (error) {
            const errMsg = error.code ? `${error.code}: ${error.message}` : error.message;
            console.error(`Error checking PowerLoss for ${ci.name}:`, errMsg);
            ci.status = '40';
            ci.rtt = `Error: ${errMsg}`;
            ci.time = this.getTimestamp();
        }
    }

    async checkFuel(ci) {
        try {
            const response = await axios.get(ci.ip, {
                httpsAgent: this.httpsAgent,
                auth: {
                    username: this.settings.fuel.apiUsername,
                    password: this.settings.fuel.apiPassword
                },
                timeout: this.settings.timers.pingTimeout
            });

            const fuel = parseInt(response.data.fuel);
            const fuelLevel = `${fuel}%`;
            const now = this.getTimestamp();
            const counter = this.cisDataCounter.get(ci.index);

            ci.time = now;
            ci.ip = `Fuel level: ${fuelLevel}`;
            ci.rtt = '';

            if (fuel >= this.settings.thresholds.fuelWarningLevel) {
                ci.status = '10'; // Green
                ci.count = 0;
                counter.count = 0;
            } else if (fuel <= this.settings.thresholds.fuelCriticalLevel) {
                // Critical level
                if (counter.count === this.settings.thresholds.downThreshold) {
                    counter.downtime = now;
                }

                ci.status = '40'; // Red
                counter.count = counter.count + 1;
                ci.downtime = counter.downtime;
                ci.count = counter.count;
            } else {
                // Warning level
                ci.status = '20'; // Yellow
            }
        } catch (error) {
            console.error(`Error checking FUEL for ${ci.name}:`, error.message);
            ci.status = '40';
            ci.rtt = 'Error';
        }
    }

    async checkIcmp(ci) {
        try {
            const result = await ping.promise.probe(ci.ip, {
                timeout: this.settings.timers.pingTimeout / 1000, // Convert ms to seconds
                min_reply: 1
            });

            const now = this.getTimestamp();
            const counter = this.cisDataCounter.get(ci.index);
            ci.time = now;

            // Determine status
            let status = 'TimedOut';
            if (result.alive) {
                status = 'Success';
                ci.rtt = result.time !== 'unknown' ? `${result.time} ms` : '0 ms';
            } else {
                ci.rtt = '';
            }

            // Handle portable devices (special status)
            const baseStatus = counter.status;

            if (status === 'TimedOut') {
                if (baseStatus === 'PORTABLE') {
                    ci.status = '30'; // Gray
                    counter.count = counter.count + 1;
                    ci.count = counter.count;
                    ci.rtt = '';
                } else {
                    // Regular timeout handling
                    if (counter.count === this.settings.thresholds.downThreshold) {
                        counter.downtime = now;
                    }

                    if (counter.count < this.settings.thresholds.downThreshold) {
                        ci.status = '20'; // Yellow - Warning
                    } else {
                        ci.status = '40'; // Red - Down
                    }

                    counter.count = counter.count + 1;
                    ci.downtime = counter.downtime;
                    ci.count = counter.count;
                    ci.rtt = '';
                }
            } else if (status === 'Success') {
                ci.status = '10'; // Green
                ci.count = 0;
                counter.count = 0;
            }

            // Log high RTT
            if (result.alive && result.time !== 'unknown' &&
                parseFloat(result.time) > this.settings.thresholds.highRttThreshold) {
                await this.logToFile(ci);
            }

        } catch (error) {
            console.error(`Error checking ICMP for ${ci.name} (${ci.ip}):`, error.message);
            ci.status = '40';
            ci.rtt = 'Error';
        }
    }

    async pollSingleCi(ci) {
        // Each CI is polled independently and asynchronously
        try {
            if (ci.type === 'FUEL') {
                await this.checkFuel(ci);
            } else if (ci.type === 'icmp') {
                await this.checkIcmp(ci);
            } else if (ci.type === 'nginx') {
                await this.checkNginx(ci);
            } else if (ci.type === 'php_fpm') {
                await this.checkPhpFpm(ci);
            } else if (ci.type === 'services_json') {
                await this.checkServicesJson(ci);
            } else if (ci.type === 'disk_space') {
                await this.checkDiskSpace(ci);
            } else if (ci.type === 'powerloss') {
                await this.checkPowerLoss(ci);
            }

            // Log if status is warning or critical
            if (parseInt(ci.status) >= 30) {
                await this.logToFile(ci);
            }
        } catch (error) {
            console.error(`Error polling ${ci.name}:`, error.message);
        }
    }

    async pollAll() {
        if (!this.isRunning) return;

        console.log(`[${new Date().toISOString()}] Starting poll cycle...`);

        // Poll all CIs in parallel (non-blocking/threaded)
        const pollPromises = this.cisData.map(ci => this.pollSingleCi(ci));
        await Promise.all(pollPromises);

        // Sort by status (descending) and name (ascending)
        const sortedData = [...this.cisData].sort((a, b) => {
            const sa = String(a.status ?? '');
            const sb = String(b.status ?? '');
            if (sb !== sa) return sb.localeCompare(sa);
            return (a.name ?? '').localeCompare(b.name ?? '');
        });

        // Save results
        await this.saveResults(sortedData);

        // Display in console
        console.log('\n=== Poll Results ===');
        sortedData.forEach(ci => {
            const statusIcon = ci.status === '10' ? '✓' :
                              ci.status === '20' ? '⚠' :
                              ci.status === '30' ? '○' : '✗';
            console.log(`${statusIcon} ${(ci.name ?? '').padEnd(30)} | Status: ${ci.status} | RTT: ${ci.rtt}`);
        });
        console.log('===================\n');

        // Clean old logs
        await this.cleanOldLogs();
    }

    async saveResults(data) {
        try {
            await fs.writeFile(
                this.settings.paths.resultJson,
                JSON.stringify(data, null, 2)
            );
        } catch (error) {
            console.error('Error saving results:', error);
        }
    }

    async logToFile(ci) {
        try {
            const today = new Date().toISOString().split('T')[0];
            const logFile = path.join(this.settings.paths.logsDir, `${today}-monitoring-log.csv`);

            // Check if file exists and has content to determine if we need headers
            let needsHeader = false;
            try {
                const stat = await fs.stat(logFile);
                needsHeader = stat.size === 0;
            } catch {
                needsHeader = true;
            }

            let logLine = '';
            if (needsHeader) {
                logLine = 'Time,Name,IP,Status,RTT,Count,Downtime\n';
            }

            logLine += `${ci.time},"${ci.name}","${ci.ip}",${ci.status},"${ci.rtt}",${ci.count},"${ci.downtime}"\n`;

            await fs.appendFile(logFile, logLine);
        } catch (error) {
            console.error('Error logging to file:', error);
        }
    }

    async cleanOldLogs() {
        try {
            const files = await fs.readdir(this.settings.paths.logsDir);
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - this.settings.timers.logRetentionDays);

            for (const file of files) {
                if (!file.endsWith('.csv')) continue;

                const filePath = path.join(this.settings.paths.logsDir, file);
                const stats = await fs.stat(filePath);

                if (stats.mtime < cutoffDate) {
                    await fs.unlink(filePath);
                    console.log(`Deleted old log file: ${file}`);
                }
            }
        } catch (error) {
            console.error('Error cleaning old logs:', error);
        }
    }

    getTimestamp() {
        const now = new Date();
        return now.toISOString().replace('T', ' ').substring(0, 19);
    }

    start() {
        this.isRunning = true;
        console.log('Network Monitor started');
        console.log(`Poll interval: ${this.settings.timers.pollInterval} seconds`);

        // Start the polling loop with setInterval
        // Each poll cycle runs independently and won't block the next cycle
        this.pollInterval = setInterval(
            () => this.pollAll(),
            this.settings.timers.pollInterval * 1000
        );

        // Run first poll immediately
        this.pollAll();
    }

    stop() {
        this.isRunning = false;
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }
        console.log('Network Monitor stopped');
    }
}

module.exports = NetworkMonitor;
