#!/bin/bash
# Network Monitoring System - Startup Script (Linux/macOS)

echo "========================================="
echo "Network Monitoring System"
echo "========================================="
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    echo ""
fi

# Start the server
echo "Starting monitoring server..."
npm start
