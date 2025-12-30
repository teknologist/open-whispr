import { useState, useEffect, useRef } from "react";
import AudioManager from "../helpers/audioManager";

// Delay before hiding window after transcription completes (ms)
// This provides visual feedback that transcription was successful
const HIDE_WINDOW_DELAY_MS = 300;

export const useAudioRecording = (toast, options = {}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const audioManagerRef = useRef(null);
  const wasRecordingRef = useRef(false); // Track previous recording state for sound triggers
  const onToggleRef = useRef(options.onToggle);
  const toastRef = useRef(toast);

  // Keep refs updated
  onToggleRef.current = options.onToggle;
  toastRef.current = toast;

  // Initialize AudioManager only once
  useEffect(() => {
    console.log(
      "[useAudioRecording] useEffect running, audioManagerRef:",
      !!audioManagerRef.current,
    );

    // Initialize AudioManager only if not already initialized
    if (!audioManagerRef.current) {
      console.log("[useAudioRecording] Creating new AudioManager");
      audioManagerRef.current = new AudioManager();
    }

    // Helper to play transition sounds
    const playTransitionSound = (settingKey, defaultSound) => {
      const audioFeedbackEnabled =
        localStorage.getItem("audioFeedbackEnabled") === "true";
      if (!audioFeedbackEnabled) return;

      const sound = localStorage.getItem(settingKey) || defaultSound;
      if (sound !== "none") {
        window.electronAPI?.playAudioFeedback?.(sound);
      }
    };

    // Set up callbacks (using refs to always have latest values)
    audioManagerRef.current.setCallbacks({
      onStateChange: ({ isRecording, isProcessing }) => {
        const wasRecording = wasRecordingRef.current;

        // Play record start/stop sounds
        if (isRecording && !wasRecording) {
          playTransitionSound("soundOnRecordStart", "bubble");
        } else if (!isRecording && wasRecording && !isProcessing) {
          playTransitionSound("soundOnRecordStop", "tap");
        }

        // Track previous state for next comparison
        wasRecordingRef.current = isRecording;

        setIsRecording(isRecording);
        setIsProcessing(isProcessing);

        // Show overlay when recording starts, hide when done
        // Only show if hideIndicatorWindow is not enabled
        const hideIndicator =
          localStorage.getItem("hideIndicatorWindow") === "true";
        if ((isRecording || isProcessing) && !hideIndicator) {
          window.electronAPI?.showDictationPanel?.();
        }
      },
      onError: (error) => {
        // Play error sound if enabled
        const audioFeedbackEnabled =
          localStorage.getItem("audioFeedbackEnabled") === "true";
        if (audioFeedbackEnabled) {
          const sound = localStorage.getItem("soundOnError") || "none";
          if (sound !== "none") {
            window.electronAPI?.playAudioFeedback?.(sound);
          }
        }

        toastRef.current?.({
          title: error.title,
          description: error.description,
          variant: "destructive",
        });
      },
      onTranscriptionComplete: async (result) => {
        if (result.success) {
          setTranscript(result.text);

          // Play success sound if enabled
          const audioFeedbackEnabled =
            localStorage.getItem("audioFeedbackEnabled") === "true";
          if (audioFeedbackEnabled) {
            const sound = localStorage.getItem("soundOnSuccess") || "done";
            if (sound !== "none") {
              window.electronAPI?.playAudioFeedback?.(sound);
            }
          }

          // Paste immediately
          await audioManagerRef.current.safePaste(result.text);

          // Save to database in parallel
          audioManagerRef.current.saveTranscription(result.text);

          // Show success notification if local fallback was used
          if (
            result.source === "openai" &&
            localStorage.getItem("useLocalWhisper") === "true"
          ) {
            toastRef.current?.({
              title: "Fallback Mode",
              description: "Local Whisper failed. Used OpenAI API instead.",
              variant: "default",
            });
          }
        }

        // Hide overlay after transcription (with brief delay for visual feedback)
        setTimeout(() => {
          window.electronAPI?.hideWindow?.();
        }, HIDE_WINDOW_DELAY_MS);
      },
    });

    // Enumerate audio devices on initialization (triggers permission prompt)
    // This is critical for Linux GUI launch where audio subsystem may not be initialized
    const initializeAudioDevices = async () => {
      try {
        const result = await audioManagerRef.current.enumerateAudioDevices();

        if (!result.success) {
          if (result.error?.includes("Permission denied")) {
            console.warn(
              "[useAudioRecording] Microphone permission required. Please grant access when prompted.",
            );
          } else {
            console.warn(
              "[useAudioRecording] Audio device check failed:",
              result.error,
            );
          }
        } else if (result.devices.length === 0) {
          console.warn(
            "[useAudioRecording] No audio input devices found. Please connect a microphone.",
          );
        } else {
          console.log(
            `[useAudioRecording] Found ${result.devices.length} audio device(s)`,
          );
        }
      } catch (error) {
        console.error("[useAudioRecording] Device enumeration error:", error);
      }
    };

    initializeAudioDevices();

    // Set up hotkey listener
    const handleToggle = () => {
      if (!audioManagerRef.current) {
        console.error("[useAudioRecording] audioManagerRef.current is null!");
        return;
      }
      const currentState = audioManagerRef.current.getState();
      console.log(
        "[useAudioRecording] handleToggle called, state:",
        currentState,
      );

      if (!currentState.isRecording && !currentState.isProcessing) {
        console.log("[useAudioRecording] Starting recording...");
        audioManagerRef.current.startRecording();
      } else if (currentState.isRecording) {
        console.log("[useAudioRecording] Stopping recording...");
        audioManagerRef.current.stopRecording();
      } else {
        console.log("[useAudioRecording] Cannot toggle - still processing");
      }
      // Always call onToggle callback
      onToggleRef.current?.();
    };

    const disposeToggle = window.electronAPI.onToggleDictation(handleToggle);

    // Set up no-audio-detected listener
    const handleNoAudioDetected = () => {
      toastRef.current?.({
        title: "No Audio Detected",
        description:
          "The recording contained no detectable audio. Please try again.",
        variant: "default",
      });
    };

    const disposeNoAudio = window.electronAPI.onNoAudioDetected?.(
      handleNoAudioDetected,
    );

    console.log("[useAudioRecording] Listener registered");

    // Cleanup only on unmount
    return () => {
      console.log("[useAudioRecording] Cleanup running - disposing listeners");
      disposeToggle?.();
      disposeNoAudio?.();
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
        audioManagerRef.current = null;
      }
    };
  }, []); // Empty dependencies - only run once on mount

  const startRecording = async () => {
    if (audioManagerRef.current) {
      return await audioManagerRef.current.startRecording();
    }
    return false;
  };

  const stopRecording = () => {
    if (audioManagerRef.current) {
      return audioManagerRef.current.stopRecording();
    }
    return false;
  };

  const toggleListening = () => {
    if (!isRecording && !isProcessing) {
      startRecording();
    } else if (isRecording) {
      stopRecording();
    }
  };

  const cancelRecording = () => {
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  };

  return {
    isRecording,
    isProcessing,
    transcript,
    startRecording,
    stopRecording,
    toggleListening,
    cancelRecording,
  };
};
