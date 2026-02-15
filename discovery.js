const fs = require('fs').promises;
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');

class DeviceDiscovery {
    constructor(settings) {
        this.settings = settings;
        this.discoveredDevices = [];
        this.isRunning = false;
        this.discoveryInterval = null;

        // Create axios instance with SSL verification disabled for Fortigate API
        this.httpsAgent = new https.Agent({
            rejectUnauthorized: false
        });
    }

    // Generate a new GUID (UUID v4)
    generateGuid() {
        return crypto.randomUUID();
    }

    // Discover devices from Fortigate API
    async discoverDevices() {
        if (!this.settings.discovery.enabled) {
            console.log('Discovery is disabled in settings');
            return [];
        }

        console.log(`[${new Date().toISOString()}] Starting device discovery...`);

        try {
            // Build URL with vdom and access_token parameters
            const vdom = this.settings.discovery.fortigate.vdom || 'root';
            const url = `${this.settings.discovery.fortigate.url}?vdom=${vdom}&access_token=${this.settings.discovery.fortigate.accessToken}`;

            const response = await axios.get(url, {
                httpsAgent: this.httpsAgent,
                timeout: 10000
            });

            if (!response.data || !response.data.results) {
                console.log('No devices found in discovery response');
                return [];
            }

            const devices = response.data.results;
            console.log(`✓ Discovered ${devices.length} devices from Fortigate`);

            // Transform Fortigate devices to CIS format
            const cisDevices = devices.map(device => {
                // Extract IP address - Fortigate uses 'ipv4_address' field
                const ip = device.ipv4_address ||
                          device.ip_address ||
                          device.ip ||
                          'unknown';

                // Create device name from available fields
                const name = device.hostname ||
                           device.name ||
                           device.device_name ||
                           device.mac ||
                           `Device-${ip}`;

                // Extract device type/category
                const deviceType = device.hardware_family ||
                                 device.hardware_type ||
                                 device.device_type ||
                                 '';

                return {
                    index: '',  // Will be auto-generated
                    type: 'icmp',
                    ip: ip,
                    name: `[FG] ${name}`,  // Prefix with [FG] to identify Fortigate discoveries
                    status: '0',
                    time: '',
                    rtt: 0,
                    count: 0,
                    downtime: '',
                    discovered: new Date().toISOString(),
                    source: 'fortigate',
                    rawData: {
                        mac: device.mac || '',
                        hostname: device.hostname || '',
                        interface: device.detected_interface || '',
                        vendor: device.hardware_vendor || '',
                        model: device.hardware_version || '',
                        type: deviceType,
                        os: device.os_name || '',
                        osVersion: device.os_version || '',
                        isOnline: device.is_online || false,
                        lastSeen: device.last_seen || 0,
                        fortiapId: device.fortiap_id || '',
                        fortiapName: device.fortiap_name || '',
                        fortiapSsid: device.fortiap_ssid || ''
                    }
                };
            });

            // Filter out devices without valid IPs
            const validDevices = cisDevices.filter(d => d.ip && d.ip !== 'unknown');

            console.log(`✓ ${validDevices.length} devices have valid IP addresses`);

            this.discoveredDevices = validDevices;
            return validDevices;

        } catch (error) {
            console.error('Error during device discovery:', error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response data:', error.response.data);
            }
            return [];
        }
    }

    // Load existing discovery file
    async loadExistingDiscovery() {
        try {
            const data = await fs.readFile(this.settings.paths.cisDiscovery, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            // File doesn't exist or is invalid, return empty array
            return [];
        }
    }

    // Merge discovered devices with existing ones (by IP address)
    async mergeDevices(newDevices) {
        const existingDevices = await this.loadExistingDiscovery();
        const deviceMap = new Map();

        // Add existing devices to map (keyed by IP)
        existingDevices.forEach(device => {
            if (device.ip) {
                deviceMap.set(device.ip, device);
            }
        });

        // Update or add new devices
        newDevices.forEach(device => {
            const existing = deviceMap.get(device.ip);
            if (existing) {
                // Update existing device but keep the GUID
                device.index = existing.index;
                device.firstDiscovered = existing.firstDiscovered || device.discovered;
                device.lastDiscovered = device.discovered;
            } else {
                // New device
                device.firstDiscovered = device.discovered;
                device.lastDiscovered = device.discovered;
            }
            deviceMap.set(device.ip, device);
        });

        return Array.from(deviceMap.values());
    }

    // Save discovered devices to file
    async saveDiscoveredDevices(devices) {
        try {
            await fs.writeFile(
                this.settings.paths.cisDiscovery,
                JSON.stringify(devices, null, 4)
            );
            console.log(`✓ Saved ${devices.length} discovered devices to ${this.settings.paths.cisDiscovery}`);
            return true;
        } catch (error) {
            console.error('Error saving discovered devices:', error);
            return false;
        }
    }

    // Run discovery process
    async runDiscovery() {
        console.log('\n' + '='.repeat(60));
        console.log('DEVICE DISCOVERY PROCESS');
        console.log('='.repeat(60));

        const newDevices = await this.discoverDevices();

        if (newDevices.length === 0) {
            console.log('No devices discovered');
            console.log('='.repeat(60) + '\n');
            return [];
        }

        // Merge with existing devices
        const mergedDevices = await this.mergeDevices(newDevices);

        // Save to file
        await this.saveDiscoveredDevices(mergedDevices);

        // Summary
        console.log('\nDiscovery Summary:');
        console.log(`  Total devices: ${mergedDevices.length}`);
        console.log(`  New discoveries: ${newDevices.length}`);
        console.log('='.repeat(60) + '\n');

        return mergedDevices;
    }

    // Start periodic discovery
    start() {
        if (!this.settings.discovery.enabled) {
            console.log('Device discovery is disabled');
            return;
        }

        this.isRunning = true;
        console.log('Device Discovery started');
        console.log(`Discovery interval: ${this.settings.timers.discoveryInterval} seconds`);

        // Run discovery immediately
        this.runDiscovery();

        // Schedule periodic discovery
        this.discoveryInterval = setInterval(
            () => this.runDiscovery(),
            this.settings.timers.discoveryInterval * 1000
        );
    }

    // Stop periodic discovery
    stop() {
        this.isRunning = false;
        if (this.discoveryInterval) {
            clearInterval(this.discoveryInterval);
        }
        console.log('Device Discovery stopped');
    }

    // Manual trigger for discovery
    async trigger() {
        return await this.runDiscovery();
    }
}

module.exports = DeviceDiscovery;
