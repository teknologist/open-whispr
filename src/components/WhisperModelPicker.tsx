import React from "react";
import UnifiedModelPicker from "./UnifiedModelPicker";

interface WhisperModelPickerProps {
  selectedModel: string;
  onModelSelect: (model: string) => void;
  className?: string;
  variant?: "onboarding" | "settings";
  provider?: "whisper" | "qwen";
}

export default function WhisperModelPicker({
  selectedModel,
  onModelSelect,
  className = "",
  variant = "settings",
  provider = "whisper",
}: WhisperModelPickerProps) {
  return (
    <UnifiedModelPicker
      selectedModel={selectedModel}
      onModelSelect={onModelSelect}
      modelType="whisper"
      provider={provider}
      className={className}
      variant={variant}
    />
  );
}