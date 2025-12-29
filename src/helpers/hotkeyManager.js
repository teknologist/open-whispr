const { globalShortcut } = require("electron");

/**
 * Valid modifier keys for Electron accelerators
 */
const VALID_MODIFIERS = new Set([
  "command",
  "cmd",
  "control",
  "ctrl",
  "commandorcontrol",
  "cmdorctrl",
  "alt",
  "option",
  "altgr",
  "shift",
  "super",
  "meta",
]);

/**
 * Valid special keys for Electron accelerators
 */
const VALID_SPECIAL_KEYS = new Set([
  "plus",
  "space",
  "tab",
  "capslock",
  "numlock",
  "scrolllock",
  "backspace",
  "delete",
  "insert",
  "return",
  "enter",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "escape",
  "esc",
  "volumeup",
  "volumedown",
  "volumemute",
  "medianexttrack",
  "mediaprevioustrack",
  "mediastop",
  "mediaplaypause",
  "printscreen",
]);

/**
 * Validates if a hotkey string is a valid Electron accelerator format.
 * @param {string} hotkey - The hotkey string to validate
 * @returns {boolean} - True if valid, false otherwise
 */
function isValidAccelerator(hotkey) {
  if (!hotkey || typeof hotkey !== "string") {
    return false;
  }

  const parts = hotkey.split("+").map((p) => p.trim().toLowerCase());
  if (parts.length === 0) {
    return false;
  }

  // The last part should be the key (not a modifier)
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  // Check if all modifiers are valid
  for (const mod of modifiers) {
    if (!VALID_MODIFIERS.has(mod)) {
      return false;
    }
  }

  // Check if key is valid:
  // 1. Single character (letter or number or symbol)
  // 2. Function key (F1-F24)
  // 3. Special key
  // 4. Numpad key (num0-num9, numdec, numadd, etc.)
  if (key.length === 1) {
    return true; // Single character key
  }

  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) {
    return true; // Function key F1-F24
  }

  if (VALID_SPECIAL_KEYS.has(key)) {
    return true; // Special key
  }

  if (/^num(0|1|2|3|4|5|6|7|8|9|dec|add|sub|mult|div)$/.test(key)) {
    return true; // Numpad key
  }

  return false;
}

class HotkeyManager {
  constructor() {
    this.currentHotkey = "`";
    this.isInitialized = false;
  }

  setupShortcuts(hotkey = "`", callback) {
    if (!callback) {
      throw new Error("Callback function is required for hotkey setup");
    }

    // Validate hotkey format before attempting registration
    if (hotkey !== "GLOBE" && !isValidAccelerator(hotkey)) {
      console.error(`[HotkeyManager] Invalid hotkey format: ${hotkey}`);
      return {
        success: false,
        error: `Invalid hotkey format: "${hotkey}". Use format like "Ctrl+Shift+A" or single keys like "\`"`,
      };
    }

    // Unregister previous hotkey if set
    if (this.currentHotkey && this.currentHotkey !== "GLOBE") {
      try {
        globalShortcut.unregister(this.currentHotkey);
        console.log(
          `[HotkeyManager] Unregistered previous hotkey: ${this.currentHotkey}`,
        );
      } catch (err) {
        console.warn(
          `[HotkeyManager] Failed to unregister previous hotkey: ${err.message}`,
        );
      }
    }

    try {
      if (hotkey === "GLOBE") {
        if (process.platform !== "darwin") {
          return {
            success: false,
            error: "The Globe key is only available on macOS.",
          };
        }
        this.currentHotkey = hotkey;
        return { success: true, hotkey };
      }

      console.log(
        `[HotkeyManager] Attempting to register global hotkey: ${hotkey}`,
      );

      // Register the new hotkey
      const success = globalShortcut.register(hotkey, () => {
        console.log(`[HotkeyManager] Hotkey triggered: ${hotkey}`);
        callback();
      });

      if (success) {
        this.currentHotkey = hotkey;
        // Verify registration
        const isRegistered = globalShortcut.isRegistered(hotkey);
        console.log(
          `[HotkeyManager] Hotkey ${hotkey} registered: ${isRegistered}`,
        );
        return { success: true, hotkey };
      } else {
        console.error(`[HotkeyManager] Failed to register hotkey: ${hotkey}`);
        return {
          success: false,
          error: `Failed to register hotkey: ${hotkey}`,
        };
      }
    } catch (error) {
      console.error("[HotkeyManager] Error setting up shortcuts:", error);
      return { success: false, error: error.message };
    }
  }

  async initializeHotkey(mainWindow, callback) {
    if (!mainWindow || !callback) {
      throw new Error("mainWindow and callback are required");
    }

    // Set up default hotkey first
    this.setupShortcuts("`", callback);

    // Listen for window to be ready, then get saved hotkey
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        this.loadSavedHotkey(mainWindow, callback);
      }, 1000);
    });

    this.isInitialized = true;
  }

  async loadSavedHotkey(mainWindow, callback) {
    try {
      const savedHotkey = await mainWindow.webContents.executeJavaScript(`
        localStorage.getItem("dictationKey") || "\`"
      `);

      if (savedHotkey && savedHotkey !== "`") {
        const result = this.setupShortcuts(savedHotkey, callback);
        if (result.success) {
          // Hotkey initialized from localStorage
        }
      }
    } catch (err) {
      console.error("Failed to get saved hotkey:", err);
    }
  }

  async updateHotkey(hotkey, callback) {
    if (!callback) {
      throw new Error("Callback function is required for hotkey update");
    }

    try {
      const result = this.setupShortcuts(hotkey, callback);
      if (result.success) {
        return { success: true, message: `Hotkey updated to: ${hotkey}` };
      } else {
        return { success: false, message: result.error };
      }
    } catch (error) {
      console.error("Failed to update hotkey:", error);
      return {
        success: false,
        message: `Failed to update hotkey: ${error.message}`,
      };
    }
  }

  getCurrentHotkey() {
    return this.currentHotkey;
  }

  unregisterAll() {
    globalShortcut.unregisterAll();
  }

  isHotkeyRegistered(hotkey) {
    return globalShortcut.isRegistered(hotkey);
  }
}

module.exports = HotkeyManager;
