const path = require("path");

// Window dimension constants
const DICTATION_WINDOW_WIDTH = 600; // XL size for displaying messages and logs
const DICTATION_WINDOW_HEIGHT = 500; // XL size for displaying messages and logs
const CONTROL_PANEL_WIDTH = 1200; // Default width for settings/control panel
const CONTROL_PANEL_HEIGHT = 800; // Default height for settings/control panel

// Main dictation window configuration
const MAIN_WINDOW_CONFIG = {
  width: DICTATION_WINDOW_WIDTH,
  height: DICTATION_WINDOW_HEIGHT,
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    enableRemoteModule: false,
    sandbox: true,
  },
  frame: false,
  alwaysOnTop: true,
  resizable: true,
  transparent: true, // Opaque window for better compatibility
  show: false, // Start hidden, show when recording
  skipTaskbar: true, // Hide from taskbar since it's just a small indicator
  focusable: true,
  visibleOnAllWorkspaces: true,
  fullScreenable: false,
  hasShadow: false,
  acceptsFirstMouse: true,
  roundedCorners: true,
  backgroundColor: "#00000000", // Transparent base for semi-transparent CSS overlay
  type: process.platform === "darwin" ? "panel" : "normal",
};

// Control panel window configuration
const CONTROL_PANEL_CONFIG = {
  width: CONTROL_PANEL_WIDTH,
  height: CONTROL_PANEL_HEIGHT,
  webPreferences: {
    preload: path.join(__dirname, "..", "..", "preload.js"),
    nodeIntegration: false,
    contextIsolation: true,
    enableRemoteModule: false,
    // SECURITY NOTE: sandbox is disabled to allow IPC communication with main process
    // for model downloads, file system operations, and clipboard access.
    // All sensitive operations are still mediated through the preload script's contextBridge.
    // webSecurity is disabled to allow loading local model files and CORS-free API calls.
    // This is acceptable because: 1) No remote/untrusted content is loaded, 2) All APIs
    // are accessed through the secure preload bridge, 3) The app doesn't load external URLs.
    sandbox: false,
    webSecurity: false,
    spellcheck: false,
  },
  title: "OpenWhispr Control Panel",
  resizable: true,
  show: false,
  titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 20, y: 20 },
  frame: false,
  transparent: false,
  backgroundColor: "#ffffff",
  minimizable: true,
  maximizable: true,
  closable: true,
  fullscreenable: true,
  skipTaskbar: false, // Ensure control panel stays in taskbar
  alwaysOnTop: false, // Control panel should not be always on top
  visibleOnAllWorkspaces: false, // Control panel should stay in its workspace
  type: "normal", // Ensure it's a normal window, not a panel
};

// Window positioning utilities
class WindowPositionUtil {
  static getMainWindowPosition(display) {
    const { width, height } = MAIN_WINDOW_CONFIG;
    const MARGIN = 20;
    const x = Math.max(
      0,
      display.bounds.x + display.workArea.width - width - MARGIN,
    );
    const workArea = display.workArea || display.bounds;
    const y = Math.max(0, workArea.y + workArea.height - height - MARGIN);
    return { x, y, width, height };
  }

  static setupAlwaysOnTop(window) {
    if (process.platform === "darwin") {
      // macOS: Use panel level for proper floating behavior
      // This ensures the window stays on top across spaces and fullscreen apps
      window.setAlwaysOnTop(true, "floating", 1);
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true, // Keep Dock/Command-Tab behaviour
      });
      window.setFullScreenable(false);

      // Ensure window level is maintained
      if (window.isVisible()) {
        window.setAlwaysOnTop(true, "floating", 1);
      }
    } else if (process.platform === "win32") {
      // Windows-specific always-on-top
      window.setAlwaysOnTop(true, "screen-saver");
      // Don't skip taskbar on Windows to maintain visibility
    } else {
      // Linux and other platforms
      window.setAlwaysOnTop(true, "screen-saver");
    }

    // Bring window to front if visible
    if (window.isVisible()) {
      window.moveTop();
    }
  }

  static setupControlPanel(window) {
    // Control panel should behave like a normal application window
    // This is only called once during window creation
    // No need to repeatedly set these values
  }
}

module.exports = {
  MAIN_WINDOW_CONFIG,
  CONTROL_PANEL_CONFIG,
  WindowPositionUtil,
};
