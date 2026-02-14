import { modelRegistry } from "../models/ModelRegistry";

export const LANGUAGE_OPTIONS = [
  { value: "auto", label: "Auto-detect" },
  { value: "af", label: "Afrikaans" },
  { value: "ar", label: "Arabic" },
  { value: "hy", label: "Armenian" },
  { value: "az", label: "Azerbaijani" },
  { value: "be", label: "Belarusian" },
  { value: "bs", label: "Bosnian" },
  { value: "bg", label: "Bulgarian" },
  { value: "ca", label: "Catalan" },
  { value: "zh", label: "Chinese" },
  { value: "hr", label: "Croatian" },
  { value: "cs", label: "Czech" },
  { value: "da", label: "Danish" },
  { value: "nl", label: "Dutch" },
  { value: "en", label: "English" },
  { value: "et", label: "Estonian" },
  { value: "fi", label: "Finnish" },
  { value: "fr", label: "French" },
  { value: "gl", label: "Galician" },
  { value: "de", label: "German" },
  { value: "el", label: "Greek" },
  { value: "he", label: "Hebrew" },
  { value: "hi", label: "Hindi" },
  { value: "hu", label: "Hungarian" },
  { value: "is", label: "Icelandic" },
  { value: "id", label: "Indonesian" },
  { value: "it", label: "Italian" },
  { value: "ja", label: "Japanese" },
  { value: "kn", label: "Kannada" },
  { value: "kk", label: "Kazakh" },
  { value: "ko", label: "Korean" },
  { value: "lv", label: "Latvian" },
  { value: "lt", label: "Lithuanian" },
  { value: "mk", label: "Macedonian" },
  { value: "ms", label: "Malay" },
  { value: "mr", label: "Marathi" },
  { value: "mi", label: "Maori" },
  { value: "ne", label: "Nepali" },
  { value: "no", label: "Norwegian" },
  { value: "fa", label: "Persian" },
  { value: "pl", label: "Polish" },
  { value: "pt", label: "Portuguese" },
  { value: "ro", label: "Romanian" },
  { value: "ru", label: "Russian" },
  { value: "sr", label: "Serbian" },
  { value: "sk", label: "Slovak" },
  { value: "sl", label: "Slovenian" },
  { value: "es", label: "Spanish" },
  { value: "sw", label: "Swahili" },
  { value: "sv", label: "Swedish" },
  { value: "tl", label: "Tagalog" },
  { value: "ta", label: "Tamil" },
  { value: "th", label: "Thai" },
  { value: "tr", label: "Turkish" },
  { value: "uk", label: "Ukrainian" },
  { value: "ur", label: "Urdu" },
  { value: "vi", label: "Vietnamese" },
  { value: "cy", label: "Welsh" },
];

export const getLanguageLabel = (code: string): string => {
  const option = LANGUAGE_OPTIONS.find((lang) => lang.value === code);
  return option?.label || code;
};

// Qwen3-ASR supported languages (52 languages)
// Source: https://huggingface.co/Qwen/Qwen3-ASR-0.6B
export const QWEN_LANGUAGES = [
  "auto", // Auto-detect
  "en", "zh", "de", "fr", "es", "ru", "ja", "pt", "ko", "it",
  "nl", "ar", "hi", "tr", "vi", "th", "id", "ms", "pl", "uk",
  "cs", "ro", "hu", "el", "he", "sv", "da", "fi", "no", "bg",
  "sk", "hr", "sl", "sr", "lt", "lv", "et", "fa", "ur", "bn",
  "ta", "te", "ml", "mr", "ne", "si", "km", "lo", "my", "am",
  "af", "az"
];

// ASR Provider configuration
export type ASRProvider = "whisper" | "qwen";

export const ASR_PROVIDERS: Record<ASRProvider, {
  name: string;
  description: string;
  models: string[];
  languages: string[];
}> = {
  whisper: {
    name: "Whisper",
    description: "OpenAI Whisper via faster-whisper (58 languages)",
    models: ["tiny", "base", "small", "medium", "large-v3", "turbo",
             "distil-small.en", "distil-medium.en", "distil-large-v2", "distil-large-v3"],
    languages: LANGUAGE_OPTIONS.map(l => l.value), // All 58 languages
  },
  qwen: {
    name: "Qwen3-ASR",
    description: "Alibaba's Qwen3 ASR via transformers (52 languages)",
    models: ["qwen3-asr-0.6b", "qwen3-asr-1.7b"],
    languages: QWEN_LANGUAGES,
  },
};

// Helper to check if a language is supported by a provider
export const isLanguageSupported = (language: string, provider: ASRProvider): boolean => {
  return ASR_PROVIDERS[provider].languages.includes(language);
};

// Helper to get filtered language options for a provider
export const getLanguagesForProvider = (provider: ASRProvider) => {
  const supportedCodes = ASR_PROVIDERS[provider].languages;
  return LANGUAGE_OPTIONS.filter(lang => supportedCodes.includes(lang.value));
};

// Reasoning model configuration with provider abstraction
export const REASONING_PROVIDERS = {
  openai: {
    name: "OpenAI",
    models: [
      // GPT-5 Series (Latest)
      {
        value: "gpt-5-nano",
        label: "GPT-5 Nano",
        description: "Ultra-fast, low latency",
      },
      {
        value: "gpt-5-mini",
        label: "GPT-5 Mini",
        description: "Fast and cost-efficient (default)",
      },
      {
        value: "gpt-5",
        label: "GPT-5",
        description: "Deep reasoning, multi-step logic",
      },
      // GPT-4.1 Series
      {
        value: "gpt-4.1-nano",
        label: "GPT-4.1 Nano",
        description: "Fastest, cheapest for low latency",
      },
      {
        value: "gpt-4.1-mini",
        label: "GPT-4.1 Mini",
        description: "Improved coding, 1M context",
      },
      {
        value: "gpt-4.1",
        label: "GPT-4.1",
        description: "Best GPT-4, June 2024 knowledge",
      },
      // o-series Reasoning Models
      {
        value: "o4-mini",
        label: "o4 Mini",
        description: "Fast reasoning, math & coding",
      },
      {
        value: "o3",
        label: "o3",
        description: "Advanced reasoning, longer thinking",
      },
      {
        value: "o3-pro",
        label: "o3 Pro",
        description: "Most intelligent, deepest reasoning",
      },
      // GPT-4o Series
      {
        value: "gpt-4o-mini",
        label: "GPT-4o Mini",
        description: "Multimodal, balanced performance",
      },
      {
        value: "gpt-4o",
        label: "GPT-4o",
        description: "Multimodal with vision support",
      }
    ],
  },
  anthropic: {
    name: "Anthropic",
    models: [
      {
        value: "claude-3-5-haiku-20241022",
        label: "Claude 3.5 Haiku",
        description: "Fast and efficient",
      },
      {
        value: "claude-3-5-sonnet-20241022",
        label: "Claude 3.5 Sonnet",
        description: "Balanced performance",
      },
      {
        value: "claude-sonnet-4-20250514",
        label: "Claude Sonnet 4",
        description: "Latest balanced model",
      },
      {
        value: "claude-opus-4-1-20250805",
        label: "Claude Opus 4.1",
        description: "Frontier intelligence",
      },
    ],
  },
  gemini: {
    name: "Google Gemini",
    models: [
      {
        value: "gemini-2.5-flash-lite",
        label: "Gemini 2.5 Flash Lite",
        description: "Fast and low-cost",
      },
      {
        value: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        description: "High-performance with thinking",
      },
      {
        value: "gemini-2.5-pro",
        label: "Gemini 2.5 Pro",
        description: "Most intelligent with thinking",
      },
      {
        value: "gemini-2.0-flash",
        label: "Gemini 2.0 Flash",
        description: "1M token context",
      },
    ],
  },
  local: {
    name: "Local AI",
    models: [], // Will be populated dynamically
  },
};

// Dynamically populate local models from registry
const localModels = modelRegistry.getAllModels();
REASONING_PROVIDERS.local.models = localModels.map(model => ({
  value: model.id,
  label: model.name,
  description: `${model.description} (${model.size})`,
}));

export const getAllReasoningModels = () => {
  return Object.entries(REASONING_PROVIDERS).flatMap(([providerId, provider]) =>
    provider.models.map((model) => ({
      ...model,
      provider: providerId,
      fullLabel: `${provider.name} ${model.label}`,
    }))
  );
};

export const getReasoningModelLabel = (modelId: string): string => {
  const allModels = getAllReasoningModels();
  const model = allModels.find((m) => m.value === modelId);
  return model?.fullLabel || modelId;
};

export const getModelProvider = (modelId: string): string => {
  const allModels = getAllReasoningModels();
  const model = allModels.find((m) => m.value === modelId);
  
  // If model not found, try to infer from model name
  if (!model) {
    if (modelId.includes("claude")) return "anthropic";
    if (modelId.includes("gemini")) return "gemini";
    if (modelId.includes("gpt") || modelId.includes("o3") || modelId.includes("o4") || modelId.includes("o1")) return "openai";
    if (modelId.includes("qwen") || modelId.includes("llama") || modelId.includes("mistral")) return "local";
  }
  
  return model?.provider || "openai";
};