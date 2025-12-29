import { useCallback } from "react";
import { useLocalStorage } from "./useLocalStorage";
import { getModelProvider } from "../utils/languages";
import { API_ENDPOINTS } from "../config/constants";

export interface TranscriptionSettings {
  useLocalWhisper: boolean;
  whisperModel: string;
  allowOpenAIFallback: boolean;
  allowLocalFallback: boolean;
  fallbackWhisperModel: string;
  preferredLanguage: string;
  translateToEnglish: boolean;
  cloudTranscriptionBaseUrl?: string;
}

export interface ReasoningSettings {
  useReasoningModel: boolean;
  reasoningModel: string;
  reasoningProvider: string;
  cloudReasoningBaseUrl?: string;
}

export interface HotkeySettings {
  dictationKey: string;
}

export interface ApiKeySettings {
  openaiApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
}

export interface SilenceSettings {
  silenceAutoStop: boolean;
  silenceThreshold: number; // 300-5000ms
}

// Available audio feedback sounds
export type AudioFeedbackSound =
  | "none" // No sound
  | "beep" // System beep (no file)
  | "bubble" // Soft warm pop
  | "tap" // Minimal tactile click
  | "ping" // Subtle notification
  | "whoosh" // Gentle transition
  | "done" // Completion tone
  | "muted-alert" // Muted error alert
  | "chime" // Pleasant chime
  | "click"; // Soft click

export const SOUND_OPTIONS: { value: AudioFeedbackSound; label: string }[] = [
  { value: "none", label: "None" },
  { value: "bubble", label: "Bubble" },
  { value: "tap", label: "Tap" },
  { value: "ping", label: "Ping" },
  { value: "whoosh", label: "Whoosh" },
  { value: "done", label: "Done" },
  { value: "muted-alert", label: "Muted alert" },
  { value: "chime", label: "Chime" },
  { value: "click", label: "Click" },
  { value: "beep", label: "System beep" },
];

export interface FeedbackSettings {
  showTrayIcon: boolean;
  hideIndicatorWindow: boolean;
  audioFeedbackEnabled: boolean;
  soundOnRecordStart: AudioFeedbackSound;
  soundOnRecordStop: AudioFeedbackSound;
  soundOnSuccess: AudioFeedbackSound;
  soundOnError: AudioFeedbackSound;
}

export function useFeedbackSettings() {
  const [showTrayIcon, setShowTrayIcon] = useLocalStorage(
    "showTrayIcon",
    true,
    {
      serialize: String,
      deserialize: (value) => value !== "false", // Default true
    },
  );

  const [hideIndicatorWindow, setHideIndicatorWindow] = useLocalStorage(
    "hideIndicatorWindow",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    },
  );

  const [audioFeedbackEnabled, setAudioFeedbackEnabled] = useLocalStorage(
    "audioFeedbackEnabled",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    },
  );

  const validSounds: AudioFeedbackSound[] = [
    "none",
    "beep",
    "bubble",
    "tap",
    "ping",
    "whoosh",
    "done",
    "muted-alert",
    "chime",
    "click",
  ];

  const deserializeSound = (
    value: string,
    defaultSound: AudioFeedbackSound,
  ): AudioFeedbackSound => {
    if (validSounds.includes(value as AudioFeedbackSound)) {
      return value as AudioFeedbackSound;
    }
    return defaultSound;
  };

  const [soundOnRecordStart, setSoundOnRecordStart] =
    useLocalStorage<AudioFeedbackSound>("soundOnRecordStart", "bubble", {
      serialize: String,
      deserialize: (value) => deserializeSound(value, "bubble"),
    });

  const [soundOnRecordStop, setSoundOnRecordStop] =
    useLocalStorage<AudioFeedbackSound>("soundOnRecordStop", "tap", {
      serialize: String,
      deserialize: (value) => deserializeSound(value, "tap"),
    });

  const [soundOnSuccess, setSoundOnSuccess] =
    useLocalStorage<AudioFeedbackSound>("soundOnSuccess", "done", {
      serialize: String,
      deserialize: (value) => deserializeSound(value, "done"),
    });

  const [soundOnError, setSoundOnError] = useLocalStorage<AudioFeedbackSound>(
    "soundOnError",
    "none",
    {
      serialize: String,
      deserialize: (value) => deserializeSound(value, "none"),
    },
  );

  return {
    showTrayIcon,
    setShowTrayIcon,
    hideIndicatorWindow,
    setHideIndicatorWindow,
    audioFeedbackEnabled,
    setAudioFeedbackEnabled,
    soundOnRecordStart,
    setSoundOnRecordStart,
    soundOnRecordStop,
    setSoundOnRecordStop,
    soundOnSuccess,
    setSoundOnSuccess,
    soundOnError,
    setSoundOnError,
  };
}

// Valid Whisper model names (whitelist for security)
const VALID_WHISPER_MODELS = [
  "tiny",
  "base",
  "small",
  "medium",
  "large",
  "turbo",
  "distil-small.en",
  "distil-medium.en",
  "distil-large-v2",
  "distil-large-v3",
];

// Valid reasoning model patterns
const VALID_REASONING_MODEL_PATTERNS = [
  /^gpt-/,
  /^o[134]-/,
  /^claude-/,
  /^gemini-/,
  /^llama-/,
  /^qwen-?/i,
  /^mistral-?/i,
];

const isValidWhisperModel = (model: string): boolean => {
  return VALID_WHISPER_MODELS.includes(model.toLowerCase());
};

const isValidReasoningModel = (model: string): boolean => {
  return VALID_REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(model));
};

export function useSettings() {
  const [useLocalWhisper, setUseLocalWhisper] = useLocalStorage(
    "useLocalWhisper",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    },
  );

  const [whisperModel, setWhisperModel] = useLocalStorage(
    "whisperModel",
    "base",
    {
      serialize: String,
      deserialize: (value) => {
        // Validate against whitelist
        if (isValidWhisperModel(value)) {
          return value;
        }
        return "base"; // Default to safe value
      },
    },
  );

  const [allowOpenAIFallback, setAllowOpenAIFallback] = useLocalStorage(
    "allowOpenAIFallback",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    },
  );

  const [allowLocalFallback, setAllowLocalFallback] = useLocalStorage(
    "allowLocalFallback",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    },
  );

  const [fallbackWhisperModel, setFallbackWhisperModel] = useLocalStorage(
    "fallbackWhisperModel",
    "base",
    {
      serialize: String,
      deserialize: (value) => {
        // Validate against whitelist
        if (isValidWhisperModel(value)) {
          return value;
        }
        return "base"; // Default to safe value
      },
    },
  );

  const [preferredLanguage, setPreferredLanguage] = useLocalStorage(
    "preferredLanguage",
    "auto",
    {
      serialize: String,
      deserialize: String,
    },
  );

  const [translateToEnglish, setTranslateToEnglish] = useLocalStorage(
    "translateToEnglish",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    },
  );

  const [cloudTranscriptionBaseUrl, setCloudTranscriptionBaseUrl] =
    useLocalStorage(
      "cloudTranscriptionBaseUrl",
      API_ENDPOINTS.TRANSCRIPTION_BASE,
      {
        serialize: String,
        deserialize: String,
      },
    );

  const [cloudReasoningBaseUrl, setCloudReasoningBaseUrl] = useLocalStorage(
    "cloudReasoningBaseUrl",
    API_ENDPOINTS.OPENAI_BASE,
    {
      serialize: String,
      deserialize: String,
    },
  );

  // Reasoning settings
  const [useReasoningModel, setUseReasoningModel] = useLocalStorage(
    "useReasoningModel",
    true,
    {
      serialize: String,
      deserialize: (value) => value !== "false", // Default true
    },
  );

  const [reasoningModel, setReasoningModel] = useLocalStorage(
    "reasoningModel",
    "gpt-4o-mini",
    {
      serialize: String,
      deserialize: (value) => {
        // Validate against known model patterns
        if (isValidReasoningModel(value)) {
          return value;
        }
        return "gpt-4o-mini"; // Default to safe value
      },
    },
  );

  // API keys - use proper type-safe serializers
  const [openaiApiKey, setOpenaiApiKey] = useLocalStorage("openaiApiKey", "", {
    serialize: (v: string) => v,
    deserialize: (v: string) => v,
  });

  const [anthropicApiKey, setAnthropicApiKey] = useLocalStorage(
    "anthropicApiKey",
    "",
    {
      serialize: (v: string) => v,
      deserialize: (v: string) => v,
    },
  );

  const [geminiApiKey, setGeminiApiKey] = useLocalStorage("geminiApiKey", "", {
    serialize: (v: string) => v,
    deserialize: (v: string) => v,
  });

  // Hotkey
  const [dictationKey, setDictationKey] = useLocalStorage("dictationKey", "", {
    serialize: (v: string) => v,
    deserialize: (v: string) => v,
  });

  // Silence auto-stop settings
  const [silenceAutoStop, setSilenceAutoStop] = useLocalStorage(
    "silenceAutoStop",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    },
  );

  const [silenceThreshold, setSilenceThreshold] = useLocalStorage(
    "silenceThreshold",
    1500, // Default 1.5 seconds
    {
      serialize: String,
      deserialize: (value) => {
        const parsed = parseInt(value, 10);
        // Validate range: 300ms to 5000ms
        if (isNaN(parsed) || parsed < 300 || parsed > 5000) {
          return 1500; // Default
        }
        return parsed;
      },
    },
  );

  // Computed values
  const reasoningProvider = getModelProvider(reasoningModel);

  // Batch operations
  const updateTranscriptionSettings = useCallback(
    (settings: Partial<TranscriptionSettings>) => {
      if (settings.useLocalWhisper !== undefined)
        setUseLocalWhisper(settings.useLocalWhisper);
      if (settings.whisperModel !== undefined)
        setWhisperModel(settings.whisperModel);
      if (settings.allowOpenAIFallback !== undefined)
        setAllowOpenAIFallback(settings.allowOpenAIFallback);
      if (settings.allowLocalFallback !== undefined)
        setAllowLocalFallback(settings.allowLocalFallback);
      if (settings.fallbackWhisperModel !== undefined)
        setFallbackWhisperModel(settings.fallbackWhisperModel);
      if (settings.preferredLanguage !== undefined)
        setPreferredLanguage(settings.preferredLanguage);
      if (settings.translateToEnglish !== undefined)
        setTranslateToEnglish(settings.translateToEnglish);
      if (settings.cloudTranscriptionBaseUrl !== undefined)
        setCloudTranscriptionBaseUrl(settings.cloudTranscriptionBaseUrl);
    },
    [
      setUseLocalWhisper,
      setWhisperModel,
      setAllowOpenAIFallback,
      setAllowLocalFallback,
      setFallbackWhisperModel,
      setPreferredLanguage,
      setTranslateToEnglish,
      setCloudTranscriptionBaseUrl,
    ],
  );

  const updateReasoningSettings = useCallback(
    (settings: Partial<ReasoningSettings>) => {
      if (settings.useReasoningModel !== undefined)
        setUseReasoningModel(settings.useReasoningModel);
      if (settings.reasoningModel !== undefined)
        setReasoningModel(settings.reasoningModel);
      if (settings.cloudReasoningBaseUrl !== undefined)
        setCloudReasoningBaseUrl(settings.cloudReasoningBaseUrl);
      // reasoningProvider is computed from reasoningModel, not stored separately
    },
    [setUseReasoningModel, setReasoningModel, setCloudReasoningBaseUrl],
  );

  const updateApiKeys = useCallback(
    (keys: Partial<ApiKeySettings>) => {
      if (keys.openaiApiKey !== undefined) setOpenaiApiKey(keys.openaiApiKey);
      if (keys.anthropicApiKey !== undefined)
        setAnthropicApiKey(keys.anthropicApiKey);
      if (keys.geminiApiKey !== undefined) setGeminiApiKey(keys.geminiApiKey);
    },
    [setOpenaiApiKey, setAnthropicApiKey, setGeminiApiKey],
  );

  const updateSilenceSettings = useCallback(
    (settings: Partial<SilenceSettings>) => {
      if (settings.silenceAutoStop !== undefined)
        setSilenceAutoStop(settings.silenceAutoStop);
      if (settings.silenceThreshold !== undefined)
        setSilenceThreshold(settings.silenceThreshold);
    },
    [setSilenceAutoStop, setSilenceThreshold],
  );

  return {
    useLocalWhisper,
    whisperModel,
    allowOpenAIFallback,
    allowLocalFallback,
    fallbackWhisperModel,
    preferredLanguage,
    translateToEnglish,
    cloudTranscriptionBaseUrl,
    cloudReasoningBaseUrl,
    useReasoningModel,
    reasoningModel,
    reasoningProvider,
    openaiApiKey,
    anthropicApiKey,
    geminiApiKey,
    dictationKey,
    setUseLocalWhisper,
    setWhisperModel,
    setAllowOpenAIFallback,
    setAllowLocalFallback,
    setFallbackWhisperModel,
    setPreferredLanguage,
    setTranslateToEnglish,
    setCloudTranscriptionBaseUrl,
    setCloudReasoningBaseUrl,
    setUseReasoningModel,
    setReasoningModel,
    setReasoningProvider: (provider: string) => {
      if (provider === "custom") {
        return;
      }

      const providerModels = {
        openai: "gpt-4o-mini", // Start with cost-efficient multimodal model
        anthropic: "claude-3.5-sonnet-20241022",
        gemini: "gemini-2.5-flash",
        local: "llama-3.2-3b",
      };
      setReasoningModel(
        providerModels[provider as keyof typeof providerModels] ||
          "gpt-4o-mini",
      );
    },
    setOpenaiApiKey,
    setAnthropicApiKey,
    setGeminiApiKey,
    setDictationKey,
    silenceAutoStop,
    silenceThreshold,
    setSilenceAutoStop,
    setSilenceThreshold,
    updateTranscriptionSettings,
    updateReasoningSettings,
    updateApiKeys,
    updateSilenceSettings,
  };
}
