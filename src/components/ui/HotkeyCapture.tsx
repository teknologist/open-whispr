import React, { useState, useCallback, useRef } from "react";
import {
  keyboardEventToAccelerator,
  formatHotkeyLabel,
} from "../../utils/hotkeys";

/**
 * Props for the HotkeyCapture component.
 */
interface HotkeyCaptureProps {
  /** Current hotkey value in Electron accelerator format (e.g., "Ctrl+Shift+A") */
  value: string;
  /** Callback when a new hotkey is captured */
  onChange: (hotkey: string) => void;
  /** Placeholder text shown when no hotkey is set */
  placeholder?: string;
  /** Additional CSS classes */
  className?: string;
  /** Disable hotkey capture */
  disabled?: boolean;
}

/**
 * HotkeyCapture - A keyboard shortcut capture component.
 *
 * Captures keyboard shortcuts in Electron accelerator format.
 * Displays currently pressed modifiers in real-time while capturing.
 *
 * @example
 * ```tsx
 * <HotkeyCapture
 *   value={hotkey}
 *   onChange={setHotkey}
 *   placeholder="Click and press a key..."
 * />
 * ```
 */

export default function HotkeyCapture({
  value,
  onChange,
  placeholder = "Click and press a key combination...",
  className = "",
  disabled = false,
}: HotkeyCaptureProps) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [currentModifiers, setCurrentModifiers] = useState({
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (disabled) return;

      // Prevent default to stop the key from being typed
      event.preventDefault();
      event.stopPropagation();

      // Update current modifiers for visual feedback
      setCurrentModifiers({
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
      });

      // Try to convert to accelerator string
      const accelerator = keyboardEventToAccelerator(event.nativeEvent);

      if (accelerator) {
        onChange(accelerator);
        // Note: Modifiers will be reset by handleKeyUp when keys are released
        // This avoids redundant state updates
      }
    },
    [onChange, disabled],
  );

  const handleKeyUp = useCallback(() => {
    // Reset modifier display when keys are released
    setCurrentModifiers({
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    });
  }, []);

  const handleFocus = useCallback(() => {
    setIsCapturing(true);
  }, []);

  const handleBlur = useCallback(() => {
    setIsCapturing(false);
    setCurrentModifiers({
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    });
  }, []);

  // Build the display string showing currently held modifiers
  const getModifierDisplay = () => {
    const parts: string[] = [];
    if (currentModifiers.ctrl) parts.push("Ctrl");
    if (currentModifiers.alt) parts.push("Alt");
    if (currentModifiers.shift) parts.push("Shift");
    if (currentModifiers.meta) parts.push("Super");
    return parts.length > 0 ? parts.join("+") + "+..." : "";
  };

  const displayValue =
    isCapturing && getModifierDisplay()
      ? getModifierDisplay()
      : formatHotkeyLabel(value);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        readOnly
        disabled={disabled}
        value={displayValue}
        placeholder={placeholder}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={`
          w-full px-4 py-3 text-center text-lg font-mono
          border-2 rounded-lg transition-all duration-200
          cursor-pointer select-none
          ${
            isCapturing
              ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200"
              : "border-gray-300 bg-white hover:border-gray-400"
          }
          ${
            disabled
              ? "bg-gray-100 text-gray-400 cursor-not-allowed"
              : "text-gray-900"
          }
          focus:outline-none
          ${className}
        `}
      />
      {isCapturing && (
        <div className="absolute -bottom-6 left-0 right-0 text-center">
          <span className="text-xs text-indigo-600 font-medium animate-pulse">
            Press any key or combination...
          </span>
        </div>
      )}
    </div>
  );
}
