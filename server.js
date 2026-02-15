const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const NetworkMonitor = require('./monitor');
const DeviceDiscovery = require('./discovery');

// Load settings
let settings;
try {
    const settingsData = require('./settings.json');
    settings = settingsData;
} catch (error) {
    console.error('Error loading settings.json:', error);
    process.exit(1);
}

// Create Express app
const app = express();
const PORT = settings.server.port;
const HOST = settings.server.host;

// Initialize monitor and discovery
const monitor = new NetworkMonitor(settings);
const discovery = new DeviceDiscovery(settings);

// Middleware to log requests
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} from ${req.ip}`);
    next();
});

// Serve static files from wwwroot
app.use(express.static(settings.paths.wwwroot));

// Route: Serve monitoring HTML page
app.get('/', async (req, res) => {
    try {
        const htmlPath = path.join(settings.paths.wwwroot, 'monitoring.html');
        const html = await fs.readFile(htmlPath, 'utf8');
        res.contentType('text/html');
        res.send(html);
    } catch (error) {
        console.error('Error serving monitoring.html:', error);
        res.status(500).send('Error loading monitoring page');
    }
});

// Route: API endpoint for result data
app.get('/result/', async (req, res) => {
    try {
        const resultData = await fs.readFile(settings.paths.resultJson, 'utf8');
        res.contentType('application/json');
        res.send(resultData);
    } catch (error) {
        console.error('Error serving result.json:', error);
        // Return empty array if file doesn't exist yet
        res.contentType('application/json');
        res.send('[]');
    }
});

// Route: Serve diagram image
app.get('/diagram.png', async (req, res) => {
    try {
        // Convert to absolute path - res.sendFile requires absolute paths
        const diagramPath = path.resolve(path.dirname(settings.paths.resultJson), 'diagram.png');
        res.sendFile(diagramPath);
    } catch (error) {
        console.error('Error serving diagram.png:', error);
        res.status(404).send('Diagram not found');
    }
});

// Route: Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        monitor: monitor.isRunning ? 'running' : 'stopped',
        discovery: discovery.isRunning ? 'running' : 'stopped',
        timestamp: new Date().toISOString()
    });
});

// Route: Trigger manual discovery
app.post('/discovery/run', async (req, res) => {
    try {
        console.log('Manual discovery triggered via API');
        const devices = await discovery.trigger();

        // Reload monitor configuration to include new devices
        await monitor.reloadConfiguration();

        res.json({
            success: true,
            devicesDiscovered: devices.length,
            message: 'Discovery completed successfully'
        });
    } catch (error) {
        console.error('Error running discovery:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route: Get discovered devices
app.get('/discovery/devices', async (req, res) => {
    try {
        const data = await fs.readFile(settings.paths.cisDiscovery, 'utf8');
        const devices = JSON.parse(data);
        res.json(devices);
    } catch (error) {
        res.json([]);
    }
});

// Route: Get discovery status
app.get('/discovery/status', (req, res) => {
    res.json({
        enabled: settings.discovery.enabled,
        running: discovery.isRunning,
        interval: settings.timers.discoveryInterval,
        discoveredDevices: discovery.discoveredDevices.length
    });
});

// Route: Create baseline from current healthy devices
app.post('/baseline/create', async (req, res) => {
    try {
        console.log('Creating baseline from current healthy devices...');

        // Load current monitoring results (which have the live status)
        let allDevices = [];
        try {
            const resultData = await fs.readFile(settings.paths.resultJson, 'utf8');
            allDevices = JSON.parse(resultData);
            console.log(`Loaded ${allDevices.length} devices from current monitoring results`);
        } catch (error) {
            console.log('No monitoring results found. Make sure monitor is running.');
            return res.status(400).json({
                success: false,
                error: 'No monitoring results found. Please wait for monitor to run first.'
            });
        }

        // Filter to only healthy devices (status = "10")
        const healthyDevices = allDevices.filter(device => device.status === '10' || device.status === 10);

        console.log(`Found ${healthyDevices.length} healthy devices out of ${allDevices.length} total`);

        // Save baseline
        await fs.writeFile(
            settings.paths.cisBaseline,
            JSON.stringify(healthyDevices, null, 4)
        );

        // Update settings
        settings.baseline.createdAt = new Date().toISOString();
        await fs.writeFile(
            './settings.json',
            JSON.stringify(settings, null, 4)
        );

        console.log(`✓ Created baseline with ${healthyDevices.length} healthy devices`);

        res.json({
            success: true,
            totalDevices: allDevices.length,
            healthyDevices: healthyDevices.length,
            createdAt: settings.baseline.createdAt
        });
    } catch (error) {
        console.error('Error creating baseline:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route: Enable baseline mode
app.post('/baseline/enable', async (req, res) => {
    try {
        // Check if baseline exists
        try {
            await fs.access(settings.paths.cisBaseline);
        } catch (error) {
            return res.status(400).json({
                success: false,
                error: 'Baseline not created yet. Please create a baseline first.'
            });
        }

        settings.baseline.enabled = true;
        await fs.writeFile(
            './settings.json',
            JSON.stringify(settings, null, 4)
        );

        // Reload monitor configuration
        await monitor.reloadConfiguration();

        console.log('✓ Baseline mode enabled');

        res.json({
            success: true,
            message: 'Baseline mode enabled',
            createdAt: settings.baseline.createdAt
        });
    } catch (error) {
        console.error('Error enabling baseline:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route: Disable baseline mode
app.post('/baseline/disable', async (req, res) => {
    try {
        settings.baseline.enabled = false;
        await fs.writeFile(
            './settings.json',
            JSON.stringify(settings, null, 4)
        );

        // Reload monitor configuration
        await monitor.reloadConfiguration();

        console.log('✓ Baseline mode disabled');

        res.json({
            success: true,
            message: 'Baseline mode disabled. Monitoring all devices again.'
        });
    } catch (error) {
        console.error('Error disabling baseline:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route: Get baseline status
app.get('/baseline/status', async (req, res) => {
    try {
        let baselineDeviceCount = 0;
        let baselineExists = false;

        try {
            const baselineData = await fs.readFile(settings.paths.cisBaseline, 'utf8');
            const devices = JSON.parse(baselineData);
            baselineDeviceCount = devices.length;
            baselineExists = true;
        } catch (error) {
            // Baseline file doesn't exist
        }

        res.json({
            enabled: settings.baseline.enabled,
            exists: baselineExists,
            deviceCount: baselineDeviceCount,
            createdAt: settings.baseline.createdAt || null
        });
    } catch (error) {
        console.error('Error getting baseline status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route: Clear baseline
app.delete('/baseline/clear', async (req, res) => {
    try {
        // Delete baseline file
        try {
            await fs.unlink(settings.paths.cisBaseline);
        } catch (error) {
            // File doesn't exist, that's ok
        }

        // Update settings
        settings.baseline.enabled = false;
        settings.baseline.createdAt = '';
        await fs.writeFile(
            './settings.json',
            JSON.stringify(settings, null, 4)
        );

        // Reload monitor configuration
        await monitor.reloadConfiguration();

        console.log('✓ Baseline cleared');

        res.json({
            success: true,
            message: 'Baseline cleared successfully'
        });
    } catch (error) {
        console.error('Error clearing baseline:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route: List available log files
app.get('/logs/', async (req, res) => {
    try {
        const files = await fs.readdir(settings.paths.logsDir);
        const logFiles = files
            .filter(file => file.endsWith('.csv'))
            .sort()
            .reverse(); // Most recent first

        const fileDetails = await Promise.all(
            logFiles.map(async (filename) => {
                const filePath = path.join(settings.paths.logsDir, filename);
                const stats = await fs.stat(filePath);
                return {
                    filename,
                    size: stats.size,
                    modified: stats.mtime.toISOString(),
                    date: filename.split('-monitoring-log.csv')[0]
                };
            })
        );

        res.json(fileDetails);
    } catch (error) {
        console.error('Error listing log files:', error);
        res.status(500).json({ error: 'Failed to list log files' });
    }
});

// Route: Get specific log file content
app.get('/logs/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;

        // Security: Prevent directory traversal
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        if (!filename.endsWith('.csv')) {
            return res.status(400).json({ error: 'Only CSV files are allowed' });
        }

        const filePath = path.join(settings.paths.logsDir, filename);
        const content = await fs.readFile(filePath, 'utf8');

        // Parse CSV to JSON
        const lines = content.trim().split('\n');
        if (lines.length === 0) {
            return res.json([]);
        }

        // First line is header
        const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
        const data = [];

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',');
            const entry = {};

            headers.forEach((header, index) => {
                entry[header] = values[index] ? values[index].trim().replace(/"/g, '') : '';
            });

            data.push(entry);
        }

        res.json(data);
    } catch (error) {
        console.error('Error reading log file:', error);
        res.status(500).json({ error: 'Failed to read log file' });
    }
});

// Graceful shutdown handler
process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');
    monitor.stop();
    discovery.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nShutting down gracefully...');
    monitor.stop();
    discovery.stop();
    process.exit(0);
});

// Initialize and start
async function start() {
    console.log('='.repeat(60));
    console.log('Network Monitoring System - Node.js Edition');
    console.log('='.repeat(60));

    // Start discovery first (if enabled)
    if (settings.discovery.enabled) {
        console.log('\n📡 Starting device discovery...');
        discovery.start();
        // Wait a moment for first discovery to complete
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Initialize monitor (will load both static and discovered devices)
    const initialized = await monitor.initialize();
    if (!initialized) {
        console.error('Failed to initialize monitor');
        process.exit(1);
    }

    // Start monitoring
    monitor.start();

    // Start web server
    app.listen(PORT, HOST, () => {
        console.log('\n' + '='.repeat(60));
        console.log(`✓ HTTP Server Ready!`);
        console.log(`✓ Now try going to http://${HOST}:${PORT}`);
        if (settings.discovery.enabled) {
            console.log(`✓ Device Discovery Active (every ${settings.timers.discoveryInterval}s)`);
        }
        console.log('='.repeat(60) + '\n');
    });
}

// Start the application
start().catch(error => {
    console.error('Fatal error during startup:', error);
    process.exit(1);
});
