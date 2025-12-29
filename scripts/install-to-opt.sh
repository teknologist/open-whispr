#!/usr/bin/env bash

# Script to install OpenWhispr from dist tar.gz to /opt/OpenWhispr
# Version is dynamically read from package.json

set -e

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
APP_NAME="open-whispr"
DIST_DIR="dist"
TAR_FILE="${DIST_DIR}/${APP_NAME}-${VERSION}.tar.gz"
EXTRACTED_DIR="${APP_NAME}-${VERSION}"
INSTALL_DIR="/opt/OpenWhispr"

echo "Installing OpenWhispr v${VERSION} to /opt..."

# Check if tar file exists
if [ ! -f "$TAR_FILE" ]; then
    echo "Error: $TAR_FILE not found!"
    echo "Please run 'npm run dist' first to build the distribution."
    exit 1
fi

# Remove existing installation if present
if [ -d "$INSTALL_DIR" ]; then
    echo "Removing existing installation at $INSTALL_DIR..."
    sudo rm -rf "$INSTALL_DIR"
fi

# Create /opt directory if it doesn't exist (it should exist on most systems)
sudo mkdir -p /opt

# Extract tar.gz to a temporary location
echo "Extracting $TAR_FILE..."
TEMP_DIR=$(mktemp -d)
tar -xzf "$TAR_FILE" -C "$TEMP_DIR"

# Move to /opt
echo "Installing to $INSTALL_DIR..."
sudo mv "$TEMP_DIR/$EXTRACTED_DIR" "$INSTALL_DIR"

# Cleanup temp directory
rm -rf "$TEMP_DIR"

echo "Installation complete!"
echo "OpenWhispr v${VERSION} is now installed at $INSTALL_DIR"
