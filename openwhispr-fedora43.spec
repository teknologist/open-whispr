Name:           openwhispr
Version:        1.1.0
Release:        1%{?dist}
Summary:        Voice dictation application using OpenAI Whisper
License:        MIT
URL:            https://github.com/openwhispr/open-whispr
Source0:        openwhispr-fedora43.tar.gz

# Disable debuginfo for prebuilt Electron binaries
%global debug_package %{nil}
%define _build_id_links none

Requires:       ydotool
Requires:       gtk3
Requires:       libappindicator-gtk3

%description
OpenWhispr is a desktop dictation application that uses OpenAI Whisper
for speech-to-text transcription. Supports both local (privacy-focused)
and cloud (OpenAI API) processing modes.

This package includes Fedora 43+ specific fixes for GTK 2/3/4 symbol
conflicts on GNOME/Wayland.

%prep
%setup -q -n openwhispr-pkg

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}/opt
mkdir -p %{buildroot}/usr/share/applications
mkdir -p %{buildroot}/usr/local/bin

cp -r opt/OpenWhispr %{buildroot}/opt/

cat > %{buildroot}/usr/share/applications/openwhispr.desktop << 'EOF'
[Desktop Entry]
Name=OpenWhispr
Comment=Voice dictation application using OpenAI Whisper
Exec=sh -c 'XDG_SESSION_TYPE=wayland WAYLAND_DISPLAY=wayland-0 OPENWHISPR_PYTHON=${OPENWHISPR_PYTHON:-$HOME/.cache/openwhispr-venv/bin/python3} exec env -u XDG_CURRENT_DESKTOP -u GNOME_DESKTOP_SESSION_ID -u DESKTOP_SESSION -u XDG_SESSION_DESKTOP -u GDMSESSION /opt/OpenWhispr/open-whispr'
Icon=/opt/OpenWhispr/resources/src/assets/icon.png
Type=Application
Categories=AudioVideo;Audio;Utility;
Terminal=false
StartupNotify=true
EOF

cat > %{buildroot}/usr/local/bin/openwhispr << 'EOF'
#!/bin/bash
export XDG_SESSION_TYPE=wayland
export WAYLAND_DISPLAY=wayland-0
export OPENWHISPR_PYTHON="${OPENWHISPR_PYTHON:-$HOME/.cache/openwhispr-venv/bin/python3}"
exec env -u XDG_CURRENT_DESKTOP -u GNOME_DESKTOP_SESSION_ID -u DESKTOP_SESSION -u XDG_SESSION_DESKTOP -u GDMSESSION /opt/OpenWhispr/open-whispr "$@"
EOF
chmod 755 %{buildroot}/usr/local/bin/openwhispr

%files
/opt/OpenWhispr/
/usr/share/applications/openwhispr.desktop
/usr/local/bin/openwhispr

%post
update-desktop-database /usr/share/applications/ 2>/dev/null || true

%postun
update-desktop-database /usr/share/applications/ 2>/dev/null || true

%changelog
* Sat Feb 14 2026 OpenWhispr Team <support@openwhispr.com> - 1.1.0-1
- Fix whisper_bridge.py path resolution for RPM installs (use app.asar.unpacked)
- Include Qwen3-ASR integration updates and latency instrumentation

* Thu Feb 13 2025 OpenWhispr Team <support@openwhispr.com> - 1.0.17-1
- Fedora 43+ release with GTK conflict fixes
- ydotool fallback for auto-paste on GNOME/Wayland
