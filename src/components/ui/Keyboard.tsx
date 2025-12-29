import React, { useState, useEffect } from "react";
import {
  formatHotkeyLabel,
  buildAccelerator,
  parseAccelerator,
  HotkeyModifiers,
} from "../../utils/hotkeys";

interface KeyboardProps {
  selectedKey?: string;
  setSelectedKey: (key: string) => void;
}

interface KeyProps {
  keyValue: string;
  isSelected: boolean;
  isModifierActive?: boolean;
  onClick: () => void;
  width?: string;
  disabled?: boolean;
  displayValue?: React.ReactNode;
  isModifier?: boolean;
}

const Key: React.FC<KeyProps> = ({
  keyValue,
  isSelected,
  isModifierActive = false,
  onClick,
  width = "w-12",
  disabled = false,
  displayValue,
  isModifier = false,
}) => {
  const [isPressed, setIsPressed] = useState(false);

  const handleClick = () => {
    if (disabled) return;
    setIsPressed(true);
    onClick();
    setTimeout(() => setIsPressed(false), 150);
  };

  const getKeyStyles = () => {
    if (isSelected) {
      return "bg-indigo-500 text-white border-2 border-indigo-600";
    }
    if (isModifierActive) {
      return "bg-amber-400 text-amber-900 border-2 border-amber-500";
    }
    if (disabled) {
      return "bg-gray-300 text-gray-500 cursor-not-allowed";
    }
    return "bg-white text-gray-800 border-2 border-gray-300 hover:border-gray-400";
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      className={`
        ${width} h-12 rounded-lg font-mono text-sm font-medium
        transition-all duration-150 ease-in-out
        transform active:scale-95
        ${isPressed ? "translate-y-1 shadow-inner" : "translate-y-0 shadow-lg"}
        hover:translate-y-0.5 hover:shadow-md
        focus:outline-none focus:ring-2 focus:ring-indigo-300
        ${getKeyStyles()}
        ${isPressed ? "bg-gray-100" : ""}
      `}
    >
      {displayValue ?? (keyValue === "Space" ? "" : keyValue)}
    </button>
  );
};

const isMac =
  typeof navigator !== "undefined" && /Mac|Darwin/.test(navigator.platform);

export default function Keyboard({
  selectedKey,
  setSelectedKey,
}: KeyboardProps) {
  const canUseGlobe = isMac;

  // Parse current selection to get active modifiers
  const parsed = selectedKey
    ? parseAccelerator(selectedKey)
    : {
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
        key: "",
      };
  const [activeModifiers, setActiveModifiers] = useState<HotkeyModifiers>(
    parsed.modifiers,
  );
  const [selectedMainKey, setSelectedMainKey] = useState(parsed.key);

  // Sync state when selectedKey prop changes externally
  useEffect(() => {
    const newParsed = selectedKey
      ? parseAccelerator(selectedKey)
      : {
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          key: "",
        };
    setActiveModifiers(newParsed.modifiers);
    setSelectedMainKey(newParsed.key);
  }, [selectedKey]);

  const functionKeys = [
    "Esc",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
  ];
  const numberRow = [
    "`",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "0",
    "-",
    "=",
  ];
  const qwertyRow = [
    "Q",
    "W",
    "E",
    "R",
    "T",
    "Y",
    "U",
    "I",
    "O",
    "P",
    "[",
    "]",
    "\\",
  ];
  const asdfRow = ["A", "S", "D", "F", "G", "H", "J", "K", "L", ";", "'"];
  const zxcvRow = ["Z", "X", "C", "V", "B", "N", "M", ",", ".", "/"];

  // Toggle a modifier key
  const toggleModifier = (modifier: keyof HotkeyModifiers) => {
    const newModifiers = {
      ...activeModifiers,
      [modifier]: !activeModifiers[modifier],
    };
    setActiveModifiers(newModifiers);

    // If we have a main key selected, update the full hotkey
    if (selectedMainKey) {
      const newHotkey = buildAccelerator(newModifiers, selectedMainKey);
      setSelectedKey(newHotkey);
    }
  };

  // Select a main key (non-modifier)
  const handleKeyClick = (key: string) => {
    setSelectedMainKey(key);
    const newHotkey = buildAccelerator(activeModifiers, key);
    setSelectedKey(newHotkey);
  };

  // Clear all modifiers
  const clearModifiers = () => {
    const emptyModifiers = {
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    };
    setActiveModifiers(emptyModifiers);
    if (selectedMainKey) {
      setSelectedKey(selectedMainKey);
    }
  };

  // Check if a key is the selected main key
  const isMainKeySelected = (key: string) => {
    return selectedMainKey === key;
  };

  // Check if any modifiers are active
  const hasActiveModifiers =
    activeModifiers.ctrl ||
    activeModifiers.alt ||
    activeModifiers.shift ||
    activeModifiers.meta;

  useEffect(() => {
    if (!canUseGlobe && selectedMainKey === "GLOBE") {
      handleKeyClick("`");
    }
  }, [canUseGlobe, selectedMainKey]);

  return (
    <div className="p-6 bg-gradient-to-b from-gray-100 to-gray-200 rounded-2xl shadow-2xl border border-gray-300">
      {/* Modifier Keys Section */}
      <div className="mb-4 p-3 bg-white/50 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-gray-600 uppercase tracking-wide">
            Modifier Keys (click to toggle)
          </span>
          {hasActiveModifiers && (
            <button
              onClick={clearModifiers}
              className="text-xs text-gray-500 hover:text-gray-700 underline"
            >
              Clear modifiers
            </button>
          )}
        </div>
        <div className="flex gap-2 justify-center">
          <Key
            keyValue={isMac ? "⌃ Ctrl" : "Ctrl"}
            isSelected={false}
            isModifierActive={activeModifiers.ctrl}
            onClick={() => toggleModifier("ctrl")}
            width="w-20"
          />
          <Key
            keyValue={isMac ? "⌥ Alt" : "Alt"}
            isSelected={false}
            isModifierActive={activeModifiers.alt}
            onClick={() => toggleModifier("alt")}
            width="w-20"
          />
          <Key
            keyValue={isMac ? "⇧ Shift" : "Shift"}
            isSelected={false}
            isModifierActive={activeModifiers.shift}
            onClick={() => toggleModifier("shift")}
            width="w-20"
          />
          <Key
            keyValue={isMac ? "⌘ Cmd" : "⊞ Super"}
            isSelected={false}
            isModifierActive={activeModifiers.meta}
            onClick={() => toggleModifier("meta")}
            width="w-20"
          />
        </div>
      </div>

      {/* Function Keys Row */}
      <div className="flex justify-center gap-2 mb-4">
        {functionKeys.map((key) => (
          <Key
            key={key}
            keyValue={key}
            isSelected={isMainKeySelected(key)}
            onClick={() => handleKeyClick(key)}
            width={key === "Esc" ? "w-14" : "w-12"}
          />
        ))}
      </div>

      {/* Number Row */}
      <div className="flex justify-center gap-1 mb-2">
        {numberRow.map((key) => (
          <Key
            key={key}
            keyValue={key}
            isSelected={isMainKeySelected(key)}
            onClick={() => handleKeyClick(key)}
          />
        ))}
        <Key
          keyValue="Backspace"
          isSelected={isMainKeySelected("Backspace")}
          onClick={() => handleKeyClick("Backspace")}
          width="w-20"
        />
      </div>

      {/* QWERTY Row */}
      <div className="flex justify-center gap-1 mb-2">
        <Key
          keyValue="Tab"
          isSelected={isMainKeySelected("Tab")}
          onClick={() => handleKeyClick("Tab")}
          width="w-16"
        />
        {qwertyRow.map((key) => (
          <Key
            key={key}
            keyValue={key}
            isSelected={isMainKeySelected(key)}
            onClick={() => handleKeyClick(key)}
          />
        ))}
      </div>

      {/* ASDF Row */}
      <div className="flex justify-center gap-1 mb-2">
        <Key
          keyValue="Caps"
          isSelected={false}
          onClick={() => {}}
          width="w-18"
          disabled
        />
        {asdfRow.map((key) => (
          <Key
            key={key}
            keyValue={key}
            isSelected={isMainKeySelected(key)}
            onClick={() => handleKeyClick(key)}
          />
        ))}
        <Key
          keyValue="Enter"
          isSelected={isMainKeySelected("Return")}
          onClick={() => handleKeyClick("Return")}
          width="w-20"
        />
      </div>

      {/* ZXCV Row */}
      <div className="flex justify-center gap-1 mb-2">
        <div className="w-24" /> {/* Spacer for alignment */}
        {zxcvRow.map((key) => (
          <Key
            key={key}
            keyValue={key}
            isSelected={isMainKeySelected(key)}
            onClick={() => handleKeyClick(key)}
          />
        ))}
        <div className="w-24" /> {/* Spacer for alignment */}
      </div>

      {/* Bottom Row */}
      <div className="flex justify-center gap-1">
        <div className="w-16" /> {/* Spacer */}
        {canUseGlobe ? (
          <Key
            keyValue="GLOBE"
            displayValue={
              <span role="img" aria-label="Globe">
                🌐
              </span>
            }
            isSelected={isMainKeySelected("GLOBE")}
            onClick={() => handleKeyClick("GLOBE")}
            width="w-16"
          />
        ) : (
          <Key
            keyValue="Globe"
            displayValue={
              <span role="img" aria-label="Globe">
                🌐
              </span>
            }
            isSelected={false}
            onClick={() => {}}
            width="w-16"
            disabled
          />
        )}
        <Key
          keyValue="Space"
          isSelected={isMainKeySelected("Space")}
          onClick={() => handleKeyClick("Space")}
          width="w-64"
        />
        <div className="w-32" /> {/* Spacer */}
      </div>

      {/* Selected Key Display */}
      {selectedKey && (
        <div className="mt-6 text-center">
          <div className="inline-flex items-center px-4 py-2 bg-indigo-100 border-2 border-indigo-300 rounded-lg">
            <span className="text-sm text-indigo-700 mr-2">Selected:</span>
            <kbd className="px-3 py-1 bg-white border border-indigo-200 rounded font-mono text-lg font-semibold text-indigo-900">
              {formatHotkeyLabel(selectedKey)}
            </kbd>
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="mt-4 text-center text-xs text-gray-500">
        <p>
          Toggle modifier keys (Ctrl, Alt, Shift, {isMac ? "Cmd" : "Super"})
          then click a key to create combinations
        </p>
        <p className="mt-1">
          Example: Click{" "}
          <span className="font-semibold">{isMac ? "⌘ Cmd" : "⊞ Super"}</span> +{" "}
          <span className="font-semibold">Space</span> ={" "}
          <span className="font-mono">{isMac ? "⌘␣" : "⊞+Space"}</span>
        </p>
      </div>
    </div>
  );
}
