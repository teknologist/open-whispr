/**
 * Hotkey utilities for parsing and formatting keyboard shortcuts
 * Supports Electron accelerator format: https://www.electronjs.org/docs/latest/api/accelerator
 */

export interface HotkeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean; // Command on macOS, Super/Win on Windows/Linux
}

export interface ParsedHotkey {
  modifiers: HotkeyModifiers;
  key: string;
}

/**
 * Detect if running on macOS.
 * Uses Electron's process.platform via preload API when available,
 * falls back to userAgentData or navigator.platform for browser compatibility.
 */
function detectIsMac(): boolean {
  // Prefer Electron's platform detection (most reliable)
  if (
    typeof window !== "undefined" &&
    (window as any).electronAPI?.getPlatform
  ) {
    return (window as any).electronAPI.getPlatform() === "darwin";
  }

  // Modern browser detection (non-deprecated)
  if (
    typeof navigator !== "undefined" &&
    (navigator as any).userAgentData?.platform
  ) {
    return (navigator as any).userAgentData.platform === "macOS";
  }

  // Fallback to deprecated navigator.platform for older browsers
  if (typeof navigator !== "undefined" && navigator.platform) {
    return /Mac|Darwin/.test(navigator.platform);
  }

  return false;
}

const isMac = detectIsMac();

/**
 * Map of browser key names to Electron accelerator key names
 */
const KEY_MAP: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Delete",
  Enter: "Return",
  Tab: "Tab",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
};

/**
 * Keys that shouldn't be used as standalone hotkeys (only as modifiers)
 */
const MODIFIER_ONLY_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS"]);

/**
 * Convert a KeyboardEvent to an Electron accelerator string
 */
export function keyboardEventToAccelerator(
  event: KeyboardEvent,
): string | null {
  const key = event.key;

  // Don't capture modifier-only key presses
  if (MODIFIER_ONLY_KEYS.has(key)) {
    return null;
  }

  const parts: string[] = [];

  // Add modifiers in Electron's expected order
  if (event.ctrlKey) {
    parts.push(isMac ? "Ctrl" : "CommandOrControl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  if (event.metaKey) {
    // Meta is Command on Mac, Super/Windows key on other platforms
    parts.push(isMac ? "Command" : "Super");
  }

  // Map the key to Electron format
  let mappedKey = KEY_MAP[key] || key;

  // Handle single characters (letters and numbers)
  if (mappedKey.length === 1) {
    mappedKey = mappedKey.toUpperCase();
  }

  // Handle function keys
  if (/^F\d+$/i.test(mappedKey)) {
    mappedKey = mappedKey.toUpperCase();
  }

  parts.push(mappedKey);

  return parts.join("+");
}

/**
 * Parse an Electron accelerator string into modifiers and key
 */
export function parseAccelerator(accelerator: string): ParsedHotkey {
  const parts = accelerator.split("+");
  const modifiers: HotkeyModifiers = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  };

  let key = "";

  for (const part of parts) {
    const lowerPart = part.toLowerCase();
    if (
      lowerPart === "ctrl" ||
      lowerPart === "control" ||
      lowerPart === "commandorcontrol"
    ) {
      modifiers.ctrl = true;
    } else if (lowerPart === "alt" || lowerPart === "option") {
      modifiers.alt = true;
    } else if (lowerPart === "shift") {
      modifiers.shift = true;
    } else if (
      lowerPart === "meta" ||
      lowerPart === "command" ||
      lowerPart === "cmd" ||
      lowerPart === "super"
    ) {
      modifiers.meta = true;
    } else {
      key = part;
    }
  }

  return { modifiers, key };
}

/**
 * Build an Electron accelerator string from modifiers and a key
 */
export function buildAccelerator(
  modifiers: HotkeyModifiers,
  key: string,
): string {
  const parts: string[] = [];

  if (modifiers.ctrl) {
    parts.push(isMac ? "Ctrl" : "CommandOrControl");
  }
  if (modifiers.alt) {
    parts.push("Alt");
  }
  if (modifiers.shift) {
    parts.push("Shift");
  }
  if (modifiers.meta) {
    parts.push(isMac ? "Command" : "Super");
  }

  if (key) {
    parts.push(key);
  }

  return parts.join("+");
}

/**
 * Format a hotkey for display to the user
 */
export function formatHotkeyLabel(hotkey?: string | null): string {
  if (!hotkey || hotkey.trim() === "") {
    return "`";
  }

  if (hotkey === "GLOBE") {
    return "🌐 Globe";
  }

  const { modifiers, key } = parseAccelerator(hotkey);
  const parts: string[] = [];

  // Use platform-specific symbols for display
  if (modifiers.ctrl) {
    parts.push(isMac ? "⌃" : "Ctrl");
  }
  if (modifiers.alt) {
    parts.push(isMac ? "⌥" : "Alt");
  }
  if (modifiers.shift) {
    parts.push(isMac ? "⇧" : "Shift");
  }
  if (modifiers.meta) {
    parts.push(isMac ? "⌘" : "⊞");
  }

  // Format special keys for display
  let displayKey = key;
  if (key === "Space") {
    displayKey = "␣";
  } else if (key === "Up") {
    displayKey = "↑";
  } else if (key === "Down") {
    displayKey = "↓";
  } else if (key === "Left") {
    displayKey = "←";
  } else if (key === "Right") {
    displayKey = "→";
  } else if (key === "Return") {
    displayKey = "↵";
  } else if (key === "Backspace") {
    displayKey = "⌫";
  } else if (key === "Delete") {
    displayKey = "⌦";
  } else if (key === "Tab") {
    displayKey = "⇥";
  } else if (key === "Esc") {
    displayKey = "⎋";
  }

  parts.push(displayKey);

  return parts.join(isMac ? "" : "+");
}

/**
 * Check if the hotkey uses modifiers (combination key)
 */
export function hasModifiers(hotkey: string): boolean {
  const { modifiers } = parseAccelerator(hotkey);
  return modifiers.ctrl || modifiers.alt || modifiers.shift || modifiers.meta;
}

/**
 * Get platform-specific modifier display name
 */
export function getModifierDisplayName(
  modifier: keyof HotkeyModifiers,
): string {
  switch (modifier) {
    case "ctrl":
      return isMac ? "Control (⌃)" : "Ctrl";
    case "alt":
      return isMac ? "Option (⌥)" : "Alt";
    case "shift":
      return isMac ? "Shift (⇧)" : "Shift";
    case "meta":
      return isMac ? "Command (⌘)" : "Super (⊞)";
  }
}
