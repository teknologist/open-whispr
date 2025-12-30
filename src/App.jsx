import React, { useState, useEffect, useRef } from "react";
import "./index.css";
import { useToast } from "./components/ui/Toast";
import { LoadingDots } from "./components/ui/LoadingDots";
import { useHotkey } from "./hooks/useHotkey";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useFeedbackSettings, useSettings } from "./hooks/useSettings";

// Sound Wave Icon Component (for idle/hover states)
const SoundWaveIcon = ({ size = 16 }) => {
  return (
    <div className="flex items-center justify-center gap-1">
      <div
        className={`bg-white rounded-full`}
        style={{ width: size * 0.25, height: size * 0.6 }}
      ></div>
      <div
        className={`bg-white rounded-full`}
        style={{ width: size * 0.25, height: size }}
      ></div>
      <div
        className={`bg-white rounded-full`}
        style={{ width: size * 0.25, height: size * 0.6 }}
      ></div>
    </div>
  );
};

// Voice Wave Animation Component (for processing state)
const VoiceWaveIndicator = ({ isListening }) => {
  return (
    <div className="flex items-center justify-center gap-0.5">
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className={`w-0.5 bg-white rounded-full transition-all duration-150 ${
            isListening ? "animate-pulse h-4" : "h-2"
          }`}
          style={{
            animationDelay: isListening ? `${i * 0.1}s` : "0s",
            animationDuration: isListening ? `${0.6 + i * 0.1}s` : "0s",
          }}
        />
      ))}
    </div>
  );
};

// Enhanced Tooltip Component
const Tooltip = ({ children, content, emoji }) => {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div className="relative inline-block">
      <div
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
      >
        {children}
      </div>
      {isVisible && (
        <div
          className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-1 py-1 text-white bg-gradient-to-r from-neutral-800 to-neutral-700 rounded-md whitespace-nowrap z-10 transition-opacity duration-150"
          style={{ fontSize: "9.7px" }}
        >
          {emoji && <span className="mr-1">{emoji}</span>}
          {content}
          <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-2 border-r-2 border-t-2 border-transparent border-t-neutral-800"></div>
        </div>
      )}
    </div>
  );
};

export default function App() {
  const [isHovered, setIsHovered] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const commandMenuRef = useRef(null);
  const buttonRef = useRef(null);
  const { toast } = useToast();
  const { hotkey } = useHotkey();
  const { isDragging, handleMouseDown, handleMouseUp } = useWindowDrag();
  const [dragStartPos, setDragStartPos] = useState(null);
  const [hasDragged, setHasDragged] = useState(false);

  const setWindowInteractivity = React.useCallback((shouldCapture) => {
    window.electronAPI?.setMainWindowInteractivity?.(shouldCapture);
  }, []);

  useEffect(() => {
    setWindowInteractivity(false);
    return () => setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  useEffect(() => {
    if (isCommandMenuOpen) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [isCommandMenuOpen, isHovered, setWindowInteractivity]);

  const handleDictationToggle = React.useCallback(() => {
    setIsCommandMenuOpen(false);
    setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  const { isRecording, isProcessing, toggleListening, cancelRecording } =
    useAudioRecording(toast, {
      onToggle: handleDictationToggle,
    });

  // Feedback settings for tray icon and audio feedback
  const {
    showTrayIcon,
    hideIndicatorWindow,
    audioFeedbackEnabled,
    soundOnRecordStart,
    soundOnRecordStop,
  } = useFeedbackSettings();
  const prevIsRecordingRef = useRef(isRecording);

  // Settings for Whisper server
  const { useLocalWhisper, whisperModel } = useSettings();

  // Sync feedback settings to main process whenever they change
  useEffect(() => {
    window.electronAPI?.setHideIndicatorWindow?.(hideIndicatorWindow);
  }, [hideIndicatorWindow]);

  useEffect(() => {
    window.electronAPI?.setTrayEnabled?.(showTrayIcon);
  }, [showTrayIcon]);

  // Update tray icon state when recording state changes
  useEffect(() => {
    window.electronAPI?.setRecordingState?.(isRecording);
    prevIsRecordingRef.current = isRecording;
  }, [isRecording]);

  const handleClose = () => {
    window.electronAPI.hideWindow();
  };

  useEffect(() => {
    if (!isCommandMenuOpen) {
      return;
    }

    const handleClickOutside = (event) => {
      if (
        commandMenuRef.current &&
        !commandMenuRef.current.contains(event.target) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target)
      ) {
        setIsCommandMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isCommandMenuOpen]);
  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        // Priority 1: Cancel recording/transcription if active
        if (isRecording || isProcessing) {
          console.log(
            "[App] Escape pressed - cancelling recording/transcription",
          );
          cancelRecording();
          window.electronAPI?.hideWindow?.();
          return;
        }
        // Priority 2: Close command menu if open
        if (isCommandMenuOpen) {
          setIsCommandMenuOpen(false);
        } else {
          // Priority 3: Hide window
          handleClose();
        }
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [isCommandMenuOpen, isRecording, isProcessing, cancelRecording]);

  // Determine current mic state
  const getMicState = () => {
    if (isRecording) return "recording";
    if (isProcessing) return "processing";
    if (isHovered && !isRecording && !isProcessing) return "hover";
    return "idle";
  };

  const micState = getMicState();
  const isListening = isRecording || isProcessing;

  // Get microphone button properties based on state
  const getMicButtonProps = () => {
    const baseClasses =
      "rounded-full w-14 h-14 flex items-center justify-center relative overflow-hidden border-2 cursor-pointer transition-all duration-200";

    switch (micState) {
      case "idle":
        return {
          className: `${baseClasses} border-white/30 bg-white/10 hover:bg-white/20 cursor-pointer`,
          tooltip: `Press [${hotkey}] to speak`,
        };
      case "hover":
        return {
          className: `${baseClasses} border-white/50 bg-white/20 cursor-pointer`,
          tooltip: `Press [${hotkey}] to speak`,
        };
      case "recording":
        return {
          className: `${baseClasses} border-blue-400 bg-blue-600 cursor-pointer`,
          tooltip: "Recording...",
        };
      case "processing":
        return {
          className: `${baseClasses} border-purple-400 bg-purple-600 cursor-not-allowed`,
          tooltip: "Processing...",
        };
      default:
        return {
          className: `${baseClasses} border-white/30 bg-white/10 cursor-pointer`,
          tooltip: "Click to speak",
        };
    }
  };

  const micProps = getMicButtonProps();

  return (
    <div className="w-full h-full flex items-center justify-center">
      {/* Centered voice button */}
      <div className="relative">
        <Tooltip content={micProps.tooltip}>
          <button
            ref={buttonRef}
            onMouseDown={(e) => {
              setIsCommandMenuOpen(false);
              setDragStartPos({ x: e.clientX, y: e.clientY });
              setHasDragged(false);
              handleMouseDown(e);
            }}
            onMouseMove={(e) => {
              if (dragStartPos && !hasDragged) {
                const distance = Math.sqrt(
                  Math.pow(e.clientX - dragStartPos.x, 2) +
                    Math.pow(e.clientY - dragStartPos.y, 2),
                );
                if (distance > 10) {
                  // 10px threshold for drag (more forgiving on high-DPI)
                  setHasDragged(true);
                }
              }
            }}
            onMouseUp={(e) => {
              handleMouseUp(e);
              setDragStartPos(null);
            }}
            onClick={(e) => {
              if (!hasDragged) {
                setIsCommandMenuOpen(false);
                toggleListening();
              }
              e.preventDefault();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!hasDragged) {
                setWindowInteractivity(true);
                setIsCommandMenuOpen((prev) => !prev);
              }
            }}
            onMouseEnter={() => {
              setIsHovered(true);
              setWindowInteractivity(true);
            }}
            onMouseLeave={() => {
              setIsHovered(false);
              if (!isCommandMenuOpen) {
                setWindowInteractivity(false);
              }
            }}
            onFocus={() => setIsHovered(true)}
            onBlur={() => setIsHovered(false)}
            className={micProps.className}
            style={{
              cursor: isDragging ? "grabbing" : undefined,
            }}
          >
            {/* Background effects */}
            <div
              className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent transition-opacity duration-150"
              style={{ opacity: micState === "hover" ? 0.8 : 0 }}
            ></div>
            <div
              className="absolute inset-0 transition-colors duration-150"
              style={{
                backgroundColor:
                  micState === "hover" ? "rgba(0,0,0,0.1)" : "transparent",
              }}
            ></div>

            {/* Dynamic content based on state */}
            {micState === "idle" || micState === "hover" ? (
              <SoundWaveIcon size={micState === "idle" ? 12 : 14} />
            ) : micState === "recording" ? (
              <LoadingDots />
            ) : micState === "processing" ? (
              <VoiceWaveIndicator isListening={true} />
            ) : null}

            {/* State indicator ring for recording */}
            {micState === "recording" && (
              <div className="absolute inset-0 rounded-full border-2 border-blue-300 animate-pulse"></div>
            )}

            {/* State indicator ring for processing */}
            {micState === "processing" && (
              <div className="absolute inset-0 rounded-full border-2 border-purple-300 opacity-50"></div>
            )}
          </button>
        </Tooltip>
        {isCommandMenuOpen && (
          <div
            ref={commandMenuRef}
            className="absolute bottom-full right-0 mb-3 w-48 rounded-lg border border-white/10 bg-neutral-900/95 text-white shadow-lg backdrop-blur-sm"
            onMouseEnter={() => {
              setWindowInteractivity(true);
            }}
            onMouseLeave={() => {
              if (!isHovered) {
                setWindowInteractivity(false);
              }
            }}
          >
            <button
              className="w-full px-3 py-2 text-left text-sm font-medium hover:bg-white/10 focus:bg-white/10 focus:outline-none"
              onClick={() => {
                toggleListening();
              }}
            >
              {isRecording ? "Stop listening" : "Start listening"}
            </button>
            <div className="h-px bg-white/10" />
            <button
              className="w-full px-3 py-2 text-left text-sm hover:bg-white/10 focus:bg-white/10 focus:outline-none"
              onClick={() => {
                setIsCommandMenuOpen(false);
                setWindowInteractivity(false);
                handleClose();
              }}
            >
              Hide this for now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
