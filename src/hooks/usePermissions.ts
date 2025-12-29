import { useState, useCallback, useMemo, useRef } from "react";

export interface UsePermissionsReturn {
  // State
  micPermissionGranted: boolean;
  accessibilityPermissionGranted: boolean;
  isTestingAccessibility: boolean;

  requestMicPermission: () => Promise<void>;
  testAccessibilityPermission: () => Promise<void>;
  setMicPermissionGranted: (granted: boolean) => void;
  setAccessibilityPermissionGranted: (granted: boolean) => void;
}

export interface UsePermissionsProps {
  showAlertDialog: (dialog: { title: string; description?: string }) => void;
}

export const usePermissions = (
  showAlertDialog?: UsePermissionsProps["showAlertDialog"],
): UsePermissionsReturn => {
  const [micPermissionGranted, setMicPermissionGranted] = useState(false);
  const [accessibilityPermissionGranted, setAccessibilityPermissionGranted] =
    useState(false);
  const [isTestingAccessibility, setIsTestingAccessibility] = useState(false);
  const testInProgressRef = useRef(false);

  // Detect Wayland session
  const isWayland = useMemo(() => {
    return window.electronAPI?.isWayland?.() ?? false;
  }, []);

  const requestMicPermission = useCallback(async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicPermissionGranted(true);
    } catch (err) {
      console.error("Microphone permission denied:", err);
      if (showAlertDialog) {
        showAlertDialog({
          title: "Microphone Permission Required",
          description:
            "Please grant microphone permissions to use voice dictation.",
        });
      } else {
        alert("Please grant microphone permissions to use voice dictation.");
      }
    }
  }, [showAlertDialog]);

  const testAccessibilityPermission = useCallback(async () => {
    // Prevent multiple simultaneous calls
    if (testInProgressRef.current) {
      return;
    }
    testInProgressRef.current = true;
    setIsTestingAccessibility(true);

    // Use descriptive test text that users will recognize
    const testText = "[OpenWhispr Test]";

    try {
      await window.electronAPI.pasteText(testText);
      setAccessibilityPermissionGranted(true);
      if (showAlertDialog) {
        if (isWayland) {
          showAlertDialog({
            title: "✅ Text Input Test Successful",
            description:
              "wtype is working! Check if the test text appeared in another app.",
          });
        } else {
          showAlertDialog({
            title: "✅ Accessibility Test Successful",
            description:
              "Accessibility permissions working! Check if the test text appeared in another app.",
          });
        }
      } else {
        alert(
          isWayland
            ? "✅ wtype working! Check if the test text appeared in another app."
            : "✅ Accessibility permissions working! Check if the test text appeared in another app.",
        );
      }
    } catch (err: unknown) {
      console.error("Accessibility/text input test failed:", err);
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error occurred";

      if (showAlertDialog) {
        if (isWayland) {
          showAlertDialog({
            title: "❌ Text Input Failed",
            description: `wtype is not installed or not working.\n\nPlease install wtype:\n• Arch: sudo pacman -S wtype\n• Debian/Ubuntu: sudo apt install wtype\n• Fedora: sudo dnf install wtype\n\nError: ${errorMessage}`,
          });
        } else {
          showAlertDialog({
            title: "❌ Accessibility Permissions Needed",
            description:
              "Please grant accessibility permissions in System Settings to enable automatic text pasting.",
          });
        }
      } else {
        alert(
          isWayland
            ? "❌ wtype not working! Please check the Settings page for setup instructions."
            : "❌ Accessibility permissions needed! Please grant them in System Settings.",
        );
      }
    } finally {
      testInProgressRef.current = false;
      setIsTestingAccessibility(false);
    }
  }, [showAlertDialog, isWayland]);

  return {
    micPermissionGranted,
    accessibilityPermissionGranted,
    isTestingAccessibility,
    requestMicPermission,
    testAccessibilityPermission,
    setMicPermissionGranted,
    setAccessibilityPermissionGranted,
  };
};
