#!/usr/bin/env bash

# Build Fedora RPM from current source checkout.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
SPEC_FILE="$ROOT_DIR/openwhispr-fedora43.spec"
TARBALL="$ROOT_DIR/openwhispr-fedora43.tar.gz"
TOPDIR="/tmp/openwhispr-rpmbuild"

if ! command -v rpmbuild >/dev/null 2>&1; then
  echo "❌ rpmbuild not found. Install rpm-build first (e.g. sudo dnf install rpm-build)"
  exit 1
fi

if [[ ! -f "$SPEC_FILE" ]]; then
  echo "❌ Spec file not found: $SPEC_FILE"
  exit 1
fi

echo "🔨 Building renderer..."
cd "$ROOT_DIR"
npm run build:renderer

echo "📦 Building Linux unpacked app..."
npx electron-builder --linux dir

if [[ ! -d "$ROOT_DIR/dist/linux-unpacked" ]]; then
  echo "❌ Expected directory missing: $ROOT_DIR/dist/linux-unpacked"
  exit 1
fi

echo "🧰 Preparing source tarball for rpmbuild..."
TMP_PKG_DIR="$(mktemp -d)"
mkdir -p "$TMP_PKG_DIR/openwhispr-pkg/opt"
cp -r "$ROOT_DIR/dist/linux-unpacked" "$TMP_PKG_DIR/openwhispr-pkg/opt/OpenWhispr"
tar -czf "$TARBALL" -C "$TMP_PKG_DIR" openwhispr-pkg
rm -rf "$TMP_PKG_DIR"

echo "🛠️  Running rpmbuild..."
rm -rf "$TOPDIR"
mkdir -p "$TOPDIR"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
cp "$SPEC_FILE" "$TOPDIR/SPECS/"
cp "$TARBALL" "$TOPDIR/SOURCES/"
rpmbuild -bb --define "_topdir $TOPDIR" "$TOPDIR/SPECS/openwhispr-fedora43.spec"

RPM_PATH="$(find "$TOPDIR/RPMS" -type f -name "openwhispr-${VERSION}-*.rpm" | head -n 1)"
if [[ -z "$RPM_PATH" ]]; then
  RPM_PATH="$(find "$TOPDIR/RPMS" -type f -name "openwhispr-*.rpm" | head -n 1)"
fi

if [[ -z "$RPM_PATH" ]]; then
  echo "❌ RPM build completed but no RPM file found in $TOPDIR/RPMS"
  exit 1
fi

DEST_PATH="$ROOT_DIR/$(basename "$RPM_PATH")"
cp "$RPM_PATH" "$DEST_PATH"

echo "✅ RPM built: $DEST_PATH"
ls -lh "$DEST_PATH"
