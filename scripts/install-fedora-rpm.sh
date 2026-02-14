#!/usr/bin/env bash

# Install the locally built Fedora RPM for OpenWhispr.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
RPM_PATH="$ROOT_DIR/openwhispr-${VERSION}-1.fc43.x86_64.rpm"

if [[ ! -f "$RPM_PATH" ]]; then
  echo "❌ RPM not found: $RPM_PATH"
  echo "Build it first (from project root):"
  echo "  npm run build:rpm-local"
  exit 1
fi

installed_nevr="$(rpm -q --qf '%{VERSION}-%{RELEASE}.%{ARCH}' openwhispr 2>/dev/null || true)"
rpm_nevr="$(rpm -qp --qf '%{VERSION}-%{RELEASE}.%{ARCH}' "$RPM_PATH")"

echo "📦 Installing $RPM_PATH"
if [[ -n "$installed_nevr" && "$installed_nevr" == "$rpm_nevr" ]]; then
  echo "↻ Same version installed ($installed_nevr). Reinstalling..."
  sudo dnf reinstall -y "$RPM_PATH"
else
  sudo dnf install -y "$RPM_PATH"
fi

echo "✅ OpenWhispr installed"
