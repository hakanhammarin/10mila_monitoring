# Network Monitoring System - Node.js Edition

A high-performance network monitoring solution built with Node.js and Express, converted from the original PowerShell/IIS implementation.

## Features

- **Threaded/Async Polling**: Non-blocking polling ensures timeouts don't delay the polling interval
- **ICMP Monitoring**: Ping-based monitoring for network devices
- **FUEL API Monitoring**: Custom API endpoint monitoring for fuel level tracking
- **Real-time Web Interface**: Live-updating HTML dashboard with color-coded status
- **Automatic Logging**: CSV logging with automatic rotation
- **Configurable Settings**: All timers and thresholds in `settings.json`

## Architecture

### Non-Blocking Polling
The monitoring solution uses Promise.all() to poll all devices in parallel. Each device check runs asynchronously, preventing any single timeout from delaying the overall polling cycle. The main poll interval runs on a fixed schedule regardless of individual device response times.

### Status Codes
- **10** (Green): Device is online and responding normally
- **20** (Yellow): Warning - device experiencing issues or approaching threshold
- **30** (Gray): Portable device offline (expected/ignored)
- **40** (Red): Device is down and has exceeded the down threshold

## Installation

### Prerequisites
- Node.js 14.x or higher
- npm (comes with Node.js)

### Setup

1. Install dependencies:
```bash
npm install
```

2. Configure your devices in `cis.json`

3. Adjust settings in `settings.json` if needed

4. Start the server:

**Windows:**
```cmd
start.cmd
```

**Linux/macOS:**
```bash
./start.sh
```

**Or directly:**
```bash
npm start
```

## Configuration

### settings.json

```json
{
  "timers": {
    "pollInterval": 10,              // Seconds between poll cycles
    "webRefreshInterval": 5000,       // Milliseconds for web UI refresh
    "pingTimeout": 600,               // Ping timeout in milliseconds
    "logRetentionDays": 30            // Days to keep log files
  },
  "thresholds": {
    "downThreshold": 4,               // Failed polls before marking as down
    "highRttThreshold": 500,          // RTT in ms to log as high
    "fuelWarningLevel": 50,           // Fuel % warning threshold
    "fuelCriticalLevel": 10           // Fuel % critical threshold
  },
  "server": {
    "port": 8080,
    "host": "localhost"
  }
}
```

### cis.json

Configure monitored devices:

```json
[
  {
    "index": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "type": "icmp",
    "ip": "10.0.0.1",
    "name": "Router",
    "status": "0"
  },
  {
    "index": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    "type": "FUEL",
    "ip": "https://10.0.0.231:1880/api/v1/fuel",
    "name": "Fuel Monitor",
    "status": "0"
  }
]
```

**Device Types:**
- `icmp`: Standard ICMP ping monitoring
- `FUEL`: Custom API endpoint for fuel level monitoring

**Special Status Values:**
- `PORTABLE`: Device is portable/mobile, timeouts will be marked as gray (status 30) instead of red

**GUID Auto-Generation:**
The system uses GUIDs (UUIDs) for device indices instead of numeric values. On startup, the system automatically:
- Converts any numeric indices to GUIDs
- Generates new GUIDs for empty/missing indices
- Detects and fixes duplicate GUIDs
- Saves the updated configuration automatically

You can safely use numeric indices in your cis.json file - they will be automatically converted to GUIDs on first startup.

## File Structure

```
monitoring_js/
├── server.js              # Express web server
├── monitor.js             # Monitoring logic and polling
├── package.json           # Dependencies
├── settings.json          # Configuration file
├── cis.json              # Device configuration
├── start.sh              # Linux/macOS startup script
├── start.cmd             # Windows startup script
├── wwwroot/
│   └── monitoring.html   # Web interface
├── result/
│   ├── result.json       # Current monitoring results
│   └── diagram.png       # Optional network diagram
└── monitor-logs/         # CSV logs (auto-rotated)
```

## Web Interface

Access the monitoring dashboard at: `http://localhost:8080`

The interface automatically refreshes every 5 seconds and displays:
- Device status (color-coded)
- Device name
- Last poll time
- IP address or fuel level
- Round-trip time (RTT)
- Number of consecutive failed polls
- Downtime timestamp (when device went down)

## API Endpoints

- `GET /` - Main monitoring dashboard
- `GET /result/` - JSON data of current monitoring results
- `GET /diagram.png` - Network diagram (if available)
- `GET /health` - Health check endpoint

## Logging

### CSV Logs
Logs are automatically created in `monitor-logs/` directory:
- Format: `YYYY-MM-DD-monitoring-log.csv`
- Logs entries when:
  - Device status is warning or critical (≥30)
  - RTT exceeds high threshold (default 500ms)

### Log Rotation
Old logs are automatically deleted after the retention period (default 30 days).

## Comparison with PowerShell Version

### Advantages
- **Cross-platform**: Runs on Windows, Linux, and macOS
- **Better performance**: Asynchronous I/O and parallel polling
- **Non-blocking**: Timeouts don't delay polling intervals
- **Modern tooling**: npm ecosystem and easy dependency management
- **Easier maintenance**: JavaScript is more widely known than PowerShell

### Migration Notes
- All core functionality preserved
- Same HTML interface
- Same configuration file format (cis.json)
- Compatible result.json output format

## Development

For development with auto-restart on file changes:

```bash
npm run dev
```

This uses nodemon to automatically restart the server when files change.

## Troubleshooting

### Port already in use
Change the port in `settings.json`:
```json
"server": {
  "port": 3000
}
```

### Dependencies not installing
Try clearing npm cache:
```bash
npm cache clean --force
npm install
```

### FUEL API SSL errors
The monitor is configured to accept self-signed certificates. If you need strict SSL verification, modify the `httpsAgent` configuration in `monitor.js`.

## License

ISC
