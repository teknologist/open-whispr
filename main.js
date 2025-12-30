const { app, globalShortcut, BrowserWindow, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

// Enable transparent windows on Linux (native Wayland)
if (process.platform === "linux") {
  app.commandLine.appendSwitch(
    "enable-features",
    "UseOzonePlatform,WaylandWindowDecorations",
  );
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  app.commandLine.appendSwitch("enable-transparent-visuals");
  app.disableHardwareAcceleration();
}

// Ensure macOS menus use the proper casing for the app name
if (process.platform === "darwin" && app.getName() !== "OpenWhispr") {
  app.setName("OpenWhispr");
}

// Add global error handling for uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Don't exit the process for EPIPE errors as they're harmless
  if (error.code === "EPIPE") {
    return;
  }
  // For other errors, log and continue
  console.error("Error stack:", error.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Import helper modules
const DebugLogger = require("./src/helpers/debugLogger");
const EnvironmentManager = require("./src/helpers/environment");
const WindowManager = require("./src/helpers/windowManager");
const DatabaseManager = require("./src/helpers/database");
const ClipboardManager = require("./src/helpers/clipboard");
const WhisperManager = require("./src/helpers/whisper");
const TrayManager = require("./src/helpers/tray");
const IPCHandlers = require("./src/helpers/ipcHandlers");
const UpdateManager = require("./src/updater");
const GlobeKeyManager = require("./src/helpers/globeKeyManager");

// Set up PATH for production builds to find system Python
function setupProductionPath() {
  if (process.platform === "darwin" && process.env.NODE_ENV !== "development") {
    const commonPaths = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/Library/Frameworks/Python.framework/Versions/3.11/bin",
      "/Library/Frameworks/Python.framework/Versions/3.10/bin",
      "/Library/Frameworks/Python.framework/Versions/3.9/bin",
    ];

    const currentPath = process.env.PATH || "";
    const pathsToAdd = commonPaths.filter((p) => !currentPath.includes(p));

    if (pathsToAdd.length > 0) {
      process.env.PATH = `${currentPath}:${pathsToAdd.join(":")}`;
    }
  }
}

// Set up PATH before initializing managers
setupProductionPath();

/**
 * Reads the startMinimized setting from user storage
 * @returns {boolean} True if app should start minimized to tray
 */
function getStartMinimizedSetting() {
  let startMinimized = false;
  try {
    const storagePath = path.join(app.getPath("userData"), "storage");
    const settingsPath = path.join(storagePath, "settings.json");
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      startMinimized =
        settings.startMinimized === "true" || settings.startMinimized === true;
    }
  } catch (error) {
    console.error("Could not read startMinimized setting:", error.message);
  }
  return startMinimized;
}

// Parse CLI arguments - whitelist allowed arguments for security
const ALLOWED_CLI_ARGS = ["--toggle", "--debug", "--dev"];
const cliArgs = process.argv.filter((arg) => ALLOWED_CLI_ARGS.includes(arg));
const shouldToggleOnStart = cliArgs.includes("--toggle");

// Forward reference for windowManager (needed by second-instance handler)
let windowManager = null;

// Register second-instance handler BEFORE requesting lock
// This ensures the running instance receives commands from new instances
app.on("second-instance", (event, argv) => {
  console.log("[CLI] Received second-instance event with argv:", argv);
  if (argv.includes("--toggle")) {
    console.log("[CLI] Toggle command received, triggering dictation");
    if (windowManager?.mainWindow && !windowManager.mainWindow.isDestroyed()) {
      windowManager.showDictationPanel();
      windowManager.mainWindow.webContents.send("toggle-dictation");
    } else {
      console.log("[CLI] Window not ready yet, command ignored");
    }
  }
});

// Single instance lock for CLI integration (e.g., `openwhispr --toggle` from DE shortcut)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running - it will receive our argv via 'second-instance' event
  console.log(
    "[CLI] Another instance is running, forwarding command and exiting",
  );
  app.exit(0); // Use exit() instead of quit() to stop immediately
}

// Initialize managers
const environmentManager = new EnvironmentManager();
windowManager = new WindowManager();
const hotkeyManager = windowManager.hotkeyManager;
const databaseManager = new DatabaseManager();
const clipboardManager = new ClipboardManager();
const whisperManager = new WhisperManager();
const trayManager = new TrayManager();
const updateManager = new UpdateManager();
const globeKeyManager = new GlobeKeyManager();
let globeKeyAlertShown = false;

if (process.platform === "darwin") {
  globeKeyManager.on("error", (error) => {
    if (globeKeyAlertShown) {
      return;
    }
    globeKeyAlertShown = true;

    const detailLines = [
      error?.message ||
        "Unknown error occurred while starting the Globe listener.",
      "The Globe key shortcut will remain disabled; existing keyboard shortcuts continue to work.",
    ];

    if (process.env.NODE_ENV === "development") {
      detailLines.push(
        "Run `npm run compile:globe` and rebuild the app to regenerate the listener binary.",
      );
    } else {
      detailLines.push(
        "Try reinstalling OpenWhispr or contact support if the issue persists.",
      );
    }

    dialog.showMessageBox({
      type: "warning",
      title: "Globe Hotkey Unavailable",
      message: "OpenWhispr could not activate the Globe key hotkey.",
      detail: detailLines.join("\n\n"),
    });
  });
}

// Initialize IPC handlers with all managers
const ipcHandlers = new IPCHandlers({
  environmentManager,
  databaseManager,
  clipboardManager,
  whisperManager,
  windowManager,
  trayManager,
});

// Main application startup
async function startApp() {
  // In development, add a small delay to let Vite start properly
  if (process.env.NODE_ENV === "development") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Ensure dock is visible on macOS and stays visible
  if (process.platform === "darwin" && app.dock) {
    app.dock.show();
    // Prevent dock from hiding when windows use setVisibleOnAllWorkspaces
    app.setActivationPolicy("regular");
  }

  // Initialize Whisper manager at startup (don't await to avoid blocking)
  whisperManager.initializeAtStartup().catch((err) => {
    // Whisper not being available at startup is not critical
  });

  // Create main window
  try {
    await windowManager.createMainWindow();

    // If started with --toggle, trigger dictation after window is ready
    if (shouldToggleOnStart && windowManager.mainWindow) {
      console.log("[CLI] Started with --toggle, will trigger dictation");
      windowManager.mainWindow.webContents.once("did-finish-load", () => {
        setTimeout(() => {
          console.log("[CLI] Triggering dictation on startup");
          windowManager.showDictationPanel();
          windowManager.mainWindow.webContents.send("toggle-dictation");
        }, 500);
      });
    }
  } catch (error) {
    console.error("Error creating main window:", error);
  }

  // Create control panel window
  try {
    const startMinimized = getStartMinimizedSetting();
    await windowManager.createControlPanelWindow(startMinimized);
  } catch (error) {
    console.error("Error creating control panel window:", error);
  }

  // Set up tray
  trayManager.setWindows(
    windowManager.mainWindow,
    windowManager.controlPanelWindow,
  );
  trayManager.setWindowManager(windowManager);
  trayManager.setCreateControlPanelCallback(() =>
    windowManager.createControlPanelWindow(getStartMinimizedSetting()),
  );
  await trayManager.createTray();

  // Set windows for update manager and check for updates
  updateManager.setWindows(
    windowManager.mainWindow,
    windowManager.controlPanelWindow,
  );
  updateManager.checkForUpdatesOnStartup();

  if (process.platform === "darwin") {
    globeKeyManager.on("globe-down", () => {
      if (
        hotkeyManager.getCurrentHotkey &&
        hotkeyManager.getCurrentHotkey() === "GLOBE"
      ) {
        if (
          windowManager.mainWindow &&
          !windowManager.mainWindow.isDestroyed()
        ) {
          windowManager.showDictationPanel();
          windowManager.mainWindow.webContents.send("toggle-dictation");
        }
      }
    });

    globeKeyManager.start();
  }
}

// App event handlers
app.whenReady().then(async () => {
  // Hide dock icon on macOS for a cleaner experience
  // The app will still show in the menu bar and command bar
  if (process.platform === "darwin" && app.dock) {
    // Keep dock visible for now to maintain command bar access
    // We can hide it later if needed: app.dock.hide()
  }

  // Linux requires a delay before creating transparent windows
  // See: https://github.com/electron/electron/issues/15947
  if (process.platform === "linux") {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  startApp();
});

app.on("window-all-closed", () => {
  // Don't quit on macOS when all windows are closed
  // The app should stay in the dock/menu bar
  if (process.platform !== "darwin") {
    app.quit();
  }
  // On macOS, keep the app running even without windows
});

app.on("browser-window-focus", (event, window) => {
  // Only apply always-on-top to the dictation window, not the control panel
  if (
    windowManager &&
    windowManager.mainWindow &&
    !windowManager.mainWindow.isDestroyed()
  ) {
    // Check if the focused window is the dictation window
    if (window === windowManager.mainWindow) {
      windowManager.enforceMainWindowOnTop();
    }
  }

  // Control panel doesn't need any special handling on focus
  // It should behave like a normal window
});

app.on("activate", () => {
  // On macOS, re-create windows when dock icon is clicked
  if (BrowserWindow.getAllWindows().length === 0) {
    if (windowManager) {
      windowManager.createMainWindow();
      // Respect startMinimized when recreating windows after all are closed
      windowManager.createControlPanelWindow(getStartMinimizedSetting());
    }
  } else {
    // Show control panel when dock icon is clicked (most common user action)
    if (
      windowManager &&
      windowManager.controlPanelWindow &&
      !windowManager.controlPanelWindow.isDestroyed()
    ) {
      windowManager.controlPanelWindow.show();
      windowManager.controlPanelWindow.focus();
    } else if (windowManager) {
      // If control panel doesn't exist, create it and show (user action)
      windowManager.createControlPanelWindow(false);
    }

    // Ensure dictation panel maintains its always-on-top status
    if (
      windowManager &&
      windowManager.mainWindow &&
      !windowManager.mainWindow.isDestroyed()
    ) {
      windowManager.enforceMainWindowOnTop();
    }
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  globeKeyManager.stop();
  updateManager.cleanup();
  // Stop Whisper server gracefully
  whisperManager.stopServer().catch((err) => {
    console.error("[main] Error stopping Whisper server:", err);
  });
});
