import ReasoningService from "../services/ReasoningService";
import {
  API_ENDPOINTS,
  buildApiUrl,
  normalizeBaseUrl,
} from "../config/constants";

const isDebugMode =
  typeof process !== "undefined" &&
  (process.env.OPENWHISPR_DEBUG === "true" ||
    process.env.NODE_ENV === "development");
const SHORT_CLIP_DURATION_SECONDS = 2.5;
const REASONING_CACHE_TTL = 30000; // 30 seconds

const debugLogger = {
  logReasoning: async (stage, details) => {
    if (!isDebugMode) return;

    if (window.electronAPI?.logReasoning) {
      try {
        await window.electronAPI.logReasoning(stage, details);
      } catch (error) {
        // Silent fail
      }
    }
  },
};

// Default silence detection settings
const DEFAULT_SILENCE_THRESHOLD_MS = 1500; // 1.5 seconds
const SILENCE_CHECK_INTERVAL_MS = 100; // Check every 100ms
const SILENCE_AMPLITUDE_THRESHOLD = 0.02; // RMS level below this is considered silence
const FREQUENCY_DATA_MAX = 255; // Uint8Array max value for frequency data

class AudioManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.isProcessing = false;
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    this.cachedApiKey = null;
    this.cachedTranscriptionEndpoint = null;
    this.recordingStartTime = null;
    this.reasoningAvailabilityCache = { value: false, expiresAt: 0 };
    this.cachedReasoningPreference = null;

    // Silence detection
    this.audioContext = null;
    this.analyser = null;
    this.silenceDetectionSource = null; // MediaStreamSource for proper cleanup
    this.silenceCheckInterval = null;
    this.silenceStartTime = null;
    this.hasDetectedSpeech = false; // Only stop after speech has been detected
    this.cachedSilenceSettings = null; // Cache to avoid repeated localStorage reads
  }

  // Get silence settings from localStorage
  getSilenceSettings() {
    const enabled = localStorage.getItem("silenceAutoStop") === "true";
    const threshold =
      parseInt(localStorage.getItem("silenceThreshold"), 10) ||
      DEFAULT_SILENCE_THRESHOLD_MS;
    return { enabled, threshold };
  }

  // Check if current audio level is silence using RMS for accuracy
  checkAudioLevel() {
    // Debug: log first call to verify interval is running
    if (!this._firstCheckLogged) {
      this._firstCheckLogged = true;
      console.log("[AudioManager] checkAudioLevel first call:", {
        hasAnalyser: !!this.analyser,
        isRecording: this.isRecording,
        cachedSettings: this.cachedSilenceSettings,
      });
      window.electronAPI?.logReasoning?.("SILENCE_FIRST_CHECK", {
        hasAnalyser: !!this.analyser,
        isRecording: this.isRecording,
        cachedSettings: this.cachedSilenceSettings,
      });
    }

    if (!this.analyser || !this.isRecording) return;

    // Use cached settings to avoid repeated localStorage reads
    const { enabled, threshold } = this.cachedSilenceSettings || {};
    if (!enabled) return;

    // Use time domain data for more accurate RMS calculation
    const timeDomainArray = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(timeDomainArray);

    // Calculate RMS (Root Mean Square) for accurate volume detection
    const rms = Math.sqrt(
      timeDomainArray.reduce(
        (sum, val) => sum + Math.pow((val - 128) / 128, 2),
        0,
      ) / timeDomainArray.length,
    );

    // Debug log every 3 seconds to avoid spam (every 30 checks at 100ms interval)
    if (!this._debugLogCounter) this._debugLogCounter = 0;
    this._debugLogCounter++;
    if (this._debugLogCounter % 30 === 0) {
      const logData = {
        rms: rms.toFixed(4),
        amplitudeThreshold: SILENCE_AMPLITUDE_THRESHOLD,
        isSilence: rms < SILENCE_AMPLITUDE_THRESHOLD,
        hasDetectedSpeech: this.hasDetectedSpeech,
        silenceDurationMs: this.silenceStartTime
          ? Date.now() - this.silenceStartTime
          : 0,
        configuredThresholdMs: threshold,
      };
      console.log("[AudioManager] Audio level check:", logData);
      // Also log via IPC to terminal
      window.electronAPI?.logReasoning?.("AUDIO_LEVEL_CHECK", logData);
    }

    if (rms < SILENCE_AMPLITUDE_THRESHOLD) {
      // Currently silence
      if (!this.silenceStartTime) {
        this.silenceStartTime = Date.now();
      } else if (this.hasDetectedSpeech) {
        // Only auto-stop after we've detected some speech
        const silenceDuration = Date.now() - this.silenceStartTime;
        if (silenceDuration >= threshold) {
          console.log(
            "[AudioManager] Auto-stopping due to silence after",
            silenceDuration,
            "ms",
          );
          // Clear interval first to prevent re-triggering (race condition fix)
          if (this.silenceCheckInterval) {
            clearInterval(this.silenceCheckInterval);
            this.silenceCheckInterval = null;
          }
          // Auto-stop recording due to silence (only if still recording)
          if (this.isRecording && this.mediaRecorder) {
            this.stopRecording();
          }
        }
      }
    } else {
      // Not silence - reset timer and mark that we've detected speech
      if (!this.hasDetectedSpeech) {
        console.log("[AudioManager] Speech detected, RMS:", rms.toFixed(4));
      }
      this.silenceStartTime = null;
      this.hasDetectedSpeech = true;
    }
  }

  // Start monitoring audio levels for silence detection
  startSilenceDetection(stream) {
    // Get settings first to check if enabled (before cleanup which clears cache)
    const settings = this.getSilenceSettings();

    // Log via IPC to show in terminal (renderer console.log only shows in DevTools)
    const logMsg = `SILENCE_SETTINGS: enabled=${settings.enabled}, threshold=${settings.threshold}ms`;
    console.log("[AudioManager]", logMsg);
    window.electronAPI?.logReasoning?.("SILENCE_DETECTION_INIT", {
      ...settings,
      rawLocalStorage: {
        silenceAutoStop: localStorage.getItem("silenceAutoStop"),
        silenceThreshold: localStorage.getItem("silenceThreshold"),
      },
    });

    if (!settings.enabled) {
      console.log("[AudioManager] Silence detection is disabled");
      this.cachedSilenceSettings = null; // Clear cache when disabled
      return;
    }

    // Clean up any existing detection first (prevents AudioContext accumulation)
    this.stopSilenceDetection();

    // Cache settings AFTER cleanup (stopSilenceDetection clears cachedSilenceSettings)
    this.cachedSilenceSettings = settings;

    try {
      this.audioContext = new (
        window.AudioContext || window.webkitAudioContext
      )();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;

      // Store source reference for proper cleanup
      this.silenceDetectionSource =
        this.audioContext.createMediaStreamSource(stream);
      this.silenceDetectionSource.connect(this.analyser);

      // Reset silence tracking
      this.silenceStartTime = null;
      this.hasDetectedSpeech = false;
      this._firstCheckLogged = false; // Reset debug flag for new recording
      this._debugLogCounter = 0; // Reset counter

      // Start checking audio levels
      this.silenceCheckInterval = setInterval(() => {
        this.checkAudioLevel();
      }, SILENCE_CHECK_INTERVAL_MS);

      console.log("[AudioManager] Silence detection started successfully");
    } catch (error) {
      console.warn("[AudioManager] Failed to start silence detection:", error);
      // Notify user that the feature isn't working
      this.onError?.({
        title: "Silence Detection Unavailable",
        description:
          "Auto-stop on silence couldn't be enabled. Recording will work normally.",
      });
    }
  }

  // Stop silence detection and cleanup
  stopSilenceDetection() {
    if (this.silenceCheckInterval) {
      clearInterval(this.silenceCheckInterval);
      this.silenceCheckInterval = null;
    }

    // Disconnect source before closing context
    if (this.silenceDetectionSource) {
      try {
        this.silenceDetectionSource.disconnect();
      } catch {
        // Ignore disconnect errors (may already be disconnected)
      }
      this.silenceDetectionSource = null;
    }

    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close().catch(() => {});
    }

    this.audioContext = null;
    this.analyser = null;
    this.silenceStartTime = null;
    this.hasDetectedSpeech = false;
    this.cachedSilenceSettings = null;
  }

  setCallbacks({ onStateChange, onError, onTranscriptionComplete }) {
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.onTranscriptionComplete = onTranscriptionComplete;
  }

  async startRecording() {
    try {
      if (this.isRecording) {
        return false;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      this.mediaRecorder = new MediaRecorder(stream);
      this.audioChunks = [];
      this.recordingStartTime = Date.now();

      this.mediaRecorder.ondataavailable = (event) => {
        this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = async () => {
        console.log("[AudioManager] onstop callback triggered");
        // Stop silence detection immediately
        this.stopSilenceDetection();

        this.isRecording = false;
        this.isProcessing = true;
        console.log(
          "[AudioManager] Calling onStateChange with isProcessing=true",
        );
        this.onStateChange?.({ isRecording: false, isProcessing: true });

        const audioBlob = new Blob(this.audioChunks, { type: "audio/wav" });
        console.log("[AudioManager] audioBlob created, size:", audioBlob.size);

        if (audioBlob.size === 0) {
          console.log("[AudioManager] WARNING: audioBlob is empty!");
        }

        const durationSeconds = this.recordingStartTime
          ? (Date.now() - this.recordingStartTime) / 1000
          : null;
        this.recordingStartTime = null;
        console.log(
          "[AudioManager] About to call processAudio, duration:",
          durationSeconds,
        );
        await this.processAudio(audioBlob, { durationSeconds });
        console.log("[AudioManager] processAudio completed");

        // Clean up stream
        stream.getTracks().forEach((track) => track.stop());
        console.log("[AudioManager] Stream tracks stopped");
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.onStateChange?.({ isRecording: true, isProcessing: false });

      // Start silence detection after recording begins
      this.startSilenceDetection(stream);

      return true;
    } catch (error) {
      // Provide more specific error messages
      let errorTitle = "Recording Error";
      let errorDescription = `Failed to access microphone: ${error.message}`;

      if (
        error.name === "NotAllowedError" ||
        error.name === "PermissionDeniedError"
      ) {
        errorTitle = "Microphone Access Denied";
        errorDescription =
          "Please grant microphone permission in your system settings and try again.";
      } else if (
        error.name === "NotFoundError" ||
        error.name === "DevicesNotFoundError"
      ) {
        errorTitle = "No Microphone Found";
        errorDescription =
          "No microphone was detected. Please connect a microphone and try again.";
      } else if (
        error.name === "NotReadableError" ||
        error.name === "TrackStartError"
      ) {
        errorTitle = "Microphone In Use";
        errorDescription =
          "The microphone is being used by another application. Please close other apps and try again.";
      }

      this.onError?.({
        title: errorTitle,
        description: errorDescription,
      });
      return false;
    }
  }

  stopRecording() {
    // Always clean up silence detection regardless of recording state
    // This prevents memory leaks if called when not recording
    this.stopSilenceDetection();

    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
      // State change will be handled in onstop callback
      return true;
    }
    return false;
  }

  async processAudio(audioBlob, metadata = {}) {
    console.log("[AudioManager] processAudio START");
    try {
      const useLocalWhisper =
        localStorage.getItem("useLocalWhisper") === "true";
      const whisperModel = localStorage.getItem("whisperModel") || "base";
      console.log(
        "[AudioManager] Using local whisper:",
        useLocalWhisper,
        "model:",
        whisperModel,
      );

      let result;
      if (useLocalWhisper) {
        console.log("[AudioManager] Calling processWithLocalWhisper...");
        result = await this.processWithLocalWhisper(
          audioBlob,
          whisperModel,
          metadata,
        );
        console.log("[AudioManager] processWithLocalWhisper returned:", {
          success: result?.success,
          textLength: result?.text?.length,
        });
      } else {
        console.log("[AudioManager] Calling processWithOpenAIAPI...");
        result = await this.processWithOpenAIAPI(audioBlob, metadata);
        console.log("[AudioManager] processWithOpenAIAPI returned:", {
          success: result?.success,
          textLength: result?.text?.length,
        });
      }
      console.log("[AudioManager] Calling onTranscriptionComplete callback...");
      this.onTranscriptionComplete?.(result);
      console.log("[AudioManager] onTranscriptionComplete callback done");
    } catch (error) {
      console.log("[AudioManager] processAudio ERROR:", error.message);
      if (error.message !== "No audio detected") {
        this.onError?.({
          title: "Transcription Error",
          description: `Transcription failed: ${error.message}`,
        });
      }
    } finally {
      console.log("[AudioManager] processAudio FINALLY - resetting state");
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
    }
  }

  async processWithLocalWhisper(audioBlob, model = "base", metadata = {}) {
    console.log("[AudioManager] processWithLocalWhisper START");
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const language = localStorage.getItem("preferredLanguage");
      const options = { model };
      if (language && language !== "auto") {
        options.language = language;
      }
      console.log("[AudioManager] Calling transcribeLocalWhisper IPC...");

      const result = await window.electronAPI.transcribeLocalWhisper(
        arrayBuffer,
        options,
      );
      console.log("[AudioManager] transcribeLocalWhisper IPC returned:", {
        success: result?.success,
        text: result?.text?.substring(0, 100),
        error: result?.error,
      });

      if (result.success && result.text) {
        console.log(
          "[AudioManager] Calling processTranscription with text:",
          result.text.substring(0, 100),
        );
        const text = await this.processTranscription(result.text, "local");
        console.log(
          "[AudioManager] processTranscription returned:",
          text?.substring(0, 100),
        );
        if (text !== null && text !== undefined) {
          return { success: true, text: text || result.text, source: "local" };
        } else {
          throw new Error("No text transcribed");
        }
      } else if (
        result.success === false &&
        result.message === "No audio detected"
      ) {
        this.onError?.({
          title: "No Audio Detected",
          description:
            "The recording contained no detectable audio. Please check your microphone settings.",
        });
        throw new Error("No audio detected");
      } else {
        throw new Error(result.error || "Local Whisper transcription failed");
      }
    } catch (error) {
      if (error.message === "No audio detected") {
        throw error;
      }

      const allowOpenAIFallback =
        localStorage.getItem("allowOpenAIFallback") === "true";
      const isLocalMode = localStorage.getItem("useLocalWhisper") === "true";

      if (allowOpenAIFallback && isLocalMode) {
        try {
          const fallbackResult = await this.processWithOpenAIAPI(
            audioBlob,
            metadata,
          );
          return { ...fallbackResult, source: "openai-fallback" };
        } catch (fallbackError) {
          throw new Error(
            `Local Whisper failed: ${error.message}. OpenAI fallback also failed: ${fallbackError.message}`,
          );
        }
      } else {
        throw new Error(`Local Whisper failed: ${error.message}`);
      }
    }
  }

  async getAPIKey() {
    if (this.cachedApiKey) {
      return this.cachedApiKey;
    }

    let apiKey = await window.electronAPI.getOpenAIKey();
    if (
      !apiKey ||
      apiKey.trim() === "" ||
      apiKey === "your_openai_api_key_here"
    ) {
      apiKey = localStorage.getItem("openaiApiKey");
    }

    if (
      !apiKey ||
      apiKey.trim() === "" ||
      apiKey === "your_openai_api_key_here"
    ) {
      throw new Error(
        "OpenAI API key not found. Please set your API key in the .env file or Control Panel.",
      );
    }

    this.cachedApiKey = apiKey;
    return apiKey;
  }

  async optimizeAudio(audioBlob) {
    return new Promise((resolve) => {
      const audioContext = new (
        window.AudioContext || window.webkitAudioContext
      )();
      const reader = new FileReader();

      reader.onload = async () => {
        try {
          const arrayBuffer = reader.result;
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

          // Convert to 16kHz mono for smaller size and faster upload
          const sampleRate = 16000;
          const channels = 1;
          const length = Math.floor(audioBuffer.duration * sampleRate);
          const offlineContext = new OfflineAudioContext(
            channels,
            length,
            sampleRate,
          );

          const source = offlineContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(offlineContext.destination);
          source.start();

          const renderedBuffer = await offlineContext.startRendering();
          const wavBlob = this.audioBufferToWav(renderedBuffer);
          resolve(wavBlob);
        } catch (error) {
          // If optimization fails, use original
          resolve(audioBlob);
        }
      };

      reader.onerror = () => resolve(audioBlob);
      reader.readAsArrayBuffer(audioBlob);
    });
  }

  audioBufferToWav(buffer) {
    const length = buffer.length;
    const arrayBuffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(arrayBuffer);
    const sampleRate = buffer.sampleRate;
    const channelData = buffer.getChannelData(0);

    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, length * 2, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      view.setInt16(
        offset,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true,
      );
      offset += 2;
    }

    return new Blob([arrayBuffer], { type: "audio/wav" });
  }

  async processWithReasoningModel(text, model, agentName) {
    console.log("[AudioManager] processWithReasoningModel START", {
      model,
      agentName,
      textLength: text.length,
    });
    debugLogger.logReasoning("CALLING_REASONING_SERVICE", {
      model,
      agentName,
      textLength: text.length,
    });

    const startTime = Date.now();

    try {
      console.log("[AudioManager] Calling ReasoningService.processText...");
      const result = await ReasoningService.processText(text, model, agentName);
      console.log("[AudioManager] ReasoningService.processText returned:", {
        resultLength: result?.length,
      });

      const processingTime = Date.now() - startTime;

      debugLogger.logReasoning("REASONING_SERVICE_COMPLETE", {
        model,
        processingTimeMs: processingTime,
        resultLength: result.length,
        success: true,
      });

      console.log(
        "[AudioManager] processWithReasoningModel SUCCESS, returning result",
      );
      return result;
    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.log(
        "[AudioManager] processWithReasoningModel ERROR:",
        error.message,
      );

      debugLogger.logReasoning("REASONING_SERVICE_ERROR", {
        model,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      throw error;
    }
  }

  async isReasoningAvailable() {
    console.log("[AudioManager] isReasoningAvailable called");
    if (typeof window === "undefined" || !window.localStorage) {
      console.log("[AudioManager] No window/localStorage - returning false");
      return false;
    }

    const storedValue = localStorage.getItem("useReasoningModel");
    const now = Date.now();
    const cacheValid =
      this.reasoningAvailabilityCache &&
      now < this.reasoningAvailabilityCache.expiresAt &&
      this.cachedReasoningPreference === storedValue;

    console.log("[AudioManager] isReasoningAvailable check:", {
      storedValue,
      cacheValid,
      cachedValue: this.reasoningAvailabilityCache?.value,
    });

    if (cacheValid) {
      console.log(
        "[AudioManager] Using cached value:",
        this.reasoningAvailabilityCache.value,
      );
      return this.reasoningAvailabilityCache.value;
    }

    debugLogger.logReasoning("REASONING_STORAGE_CHECK", {
      storedValue,
      typeOfStoredValue: typeof storedValue,
      isTrue: storedValue === "true",
      isTruthy: !!storedValue && storedValue !== "false",
    });

    const useReasoning =
      storedValue === "true" || (!!storedValue && storedValue !== "false");

    console.log(
      "[AudioManager] useReasoning (from localStorage):",
      useReasoning,
    );

    if (!useReasoning) {
      console.log(
        "[AudioManager] Reasoning disabled in settings - returning false",
      );
      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = storedValue;
      return false;
    }

    try {
      console.log("[AudioManager] Checking ReasoningService.isAvailable()...");
      const isAvailable = await ReasoningService.isAvailable();
      console.log(
        "[AudioManager] ReasoningService.isAvailable() =",
        isAvailable,
      );

      debugLogger.logReasoning("REASONING_AVAILABILITY", {
        isAvailable,
        reasoningEnabled: useReasoning,
        finalDecision: useReasoning && isAvailable,
      });

      this.reasoningAvailabilityCache = {
        value: isAvailable,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = storedValue;

      return isAvailable;
    } catch (error) {
      console.log(
        "[AudioManager] ReasoningService.isAvailable() ERROR:",
        error.message,
      );
      debugLogger.logReasoning("REASONING_AVAILABILITY_ERROR", {
        error: error.message,
        stack: error.stack,
      });

      this.reasoningAvailabilityCache = {
        value: false,
        expiresAt: now + REASONING_CACHE_TTL,
      };
      this.cachedReasoningPreference = storedValue;
      return false;
    }
  }

  async processTranscription(text, source) {
    console.log("[AudioManager] processTranscription START", {
      source,
      textLength: text?.length,
    });
    const normalizedText = typeof text === "string" ? text.trim() : "";

    debugLogger.logReasoning("TRANSCRIPTION_RECEIVED", {
      source,
      textLength: normalizedText.length,
      textPreview:
        normalizedText.substring(0, 100) +
        (normalizedText.length > 100 ? "..." : ""),
      timestamp: new Date().toISOString(),
    });

    const reasoningModel =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("reasoningModel") || "gpt-4o-mini"
        : "gpt-4o-mini";
    const reasoningProvider =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("reasoningProvider") || "auto"
        : "auto";
    const agentName =
      typeof window !== "undefined" && window.localStorage
        ? localStorage.getItem("agentName") || null
        : null;

    console.log("[AudioManager] Checking isReasoningAvailable...");
    const useReasoning = await this.isReasoningAvailable();
    console.log("[AudioManager] useReasoning =", useReasoning, {
      reasoningModel,
      reasoningProvider,
    });

    debugLogger.logReasoning("REASONING_CHECK", {
      useReasoning,
      reasoningModel,
      reasoningProvider,
      agentName,
    });

    if (useReasoning) {
      console.log(
        "[AudioManager] AI Enhancement ENABLED - calling processWithReasoningModel",
      );
      try {
        const preparedText = normalizedText;

        debugLogger.logReasoning("SENDING_TO_REASONING", {
          preparedTextLength: preparedText.length,
          model: reasoningModel,
          provider: reasoningProvider,
        });

        const result = await this.processWithReasoningModel(
          preparedText,
          reasoningModel,
          agentName,
        );

        debugLogger.logReasoning("REASONING_SUCCESS", {
          resultLength: result.length,
          resultPreview:
            result.substring(0, 100) + (result.length > 100 ? "..." : ""),
          processingTime: new Date().toISOString(),
        });

        return result;
      } catch (error) {
        debugLogger.logReasoning("REASONING_FAILED", {
          error: error.message,
          stack: error.stack,
          fallbackToCleanup: true,
        });
        console.error(`Reasoning failed (${source}):`, error.message);
      }
    }

    debugLogger.logReasoning("USING_STANDARD_CLEANUP", {
      reason: useReasoning ? "Reasoning failed" : "Reasoning not enabled",
    });

    return normalizedText;
  }

  async processWithOpenAIAPI(audioBlob, metadata = {}) {
    const language = localStorage.getItem("preferredLanguage");
    const allowLocalFallback =
      localStorage.getItem("allowLocalFallback") === "true";
    const fallbackModel =
      localStorage.getItem("fallbackWhisperModel") || "base";

    try {
      const durationSeconds = metadata.durationSeconds ?? null;
      const shouldSkipOptimizationForDuration =
        typeof durationSeconds === "number" &&
        durationSeconds > 0 &&
        durationSeconds < SHORT_CLIP_DURATION_SECONDS;

      const shouldOptimize =
        !shouldSkipOptimizationForDuration && audioBlob.size > 1024 * 1024;

      const [apiKey, optimizedAudio] = await Promise.all([
        this.getAPIKey(),
        shouldOptimize
          ? this.optimizeAudio(audioBlob)
          : Promise.resolve(audioBlob),
      ]);

      const formData = new FormData();
      formData.append("file", optimizedAudio, "audio.wav");
      formData.append("model", "whisper-1");

      if (language && language !== "auto") {
        formData.append("language", language);
      }

      const response = await fetch(this.getTranscriptionEndpoint(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error: ${response.status} ${errorText}`);
      }

      const result = await response.json();

      if (result.text) {
        const text = await this.processTranscription(result.text, "openai");
        const source = (await this.isReasoningAvailable())
          ? "openai-reasoned"
          : "openai";
        return { success: true, text, source };
      } else {
        throw new Error("No text transcribed");
      }
    } catch (error) {
      const isOpenAIMode = localStorage.getItem("useLocalWhisper") !== "true";

      if (allowLocalFallback && isOpenAIMode) {
        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const options = { model: fallbackModel };
          if (language && language !== "auto") {
            options.language = language;
          }

          const result = await window.electronAPI.transcribeLocalWhisper(
            arrayBuffer,
            options,
          );

          if (result.success && result.text) {
            const text = await this.processTranscription(
              result.text,
              "local-fallback",
            );
            if (text) {
              return { success: true, text, source: "local-fallback" };
            }
          }
          throw error;
        } catch (fallbackError) {
          throw new Error(
            `OpenAI API failed: ${error.message}. Local fallback also failed: ${fallbackError.message}`,
          );
        }
      }

      throw error;
    }
  }

  getTranscriptionEndpoint() {
    if (this.cachedTranscriptionEndpoint) {
      return this.cachedTranscriptionEndpoint;
    }

    try {
      const stored =
        typeof localStorage !== "undefined"
          ? localStorage.getItem("cloudTranscriptionBaseUrl") || ""
          : "";
      const trimmed = stored.trim();
      const base = trimmed ? trimmed : API_ENDPOINTS.TRANSCRIPTION_BASE;
      const normalizedBase = normalizeBaseUrl(base);

      if (!normalizedBase) {
        this.cachedTranscriptionEndpoint = API_ENDPOINTS.TRANSCRIPTION;
        return API_ENDPOINTS.TRANSCRIPTION;
      }

      const isLocalhost =
        normalizedBase.includes("://localhost") ||
        normalizedBase.includes("://127.0.0.1");
      if (!normalizedBase.startsWith("https://") && !isLocalhost) {
        console.warn(
          "Non-HTTPS endpoint rejected for security. Using default.",
        );
        this.cachedTranscriptionEndpoint = API_ENDPOINTS.TRANSCRIPTION;
        return API_ENDPOINTS.TRANSCRIPTION;
      }

      let endpoint;
      if (/\/audio\/(transcriptions|translations)$/i.test(normalizedBase)) {
        endpoint = normalizedBase;
      } else {
        endpoint = buildApiUrl(normalizedBase, "/audio/transcriptions");
      }

      this.cachedTranscriptionEndpoint = endpoint;
      return endpoint;
    } catch (error) {
      console.warn("Failed to resolve transcription endpoint:", error);
      this.cachedTranscriptionEndpoint = API_ENDPOINTS.TRANSCRIPTION;
      return API_ENDPOINTS.TRANSCRIPTION;
    }
  }

  async safePaste(text) {
    try {
      await window.electronAPI.pasteText(text);
      return true;
    } catch (error) {
      this.onError?.({
        title: "Paste Error",
        description: `Failed to paste text. Please check accessibility permissions. ${error.message}`,
      });
      return false;
    }
  }

  async saveTranscription(text) {
    try {
      await window.electronAPI.saveTranscription(text);
      return true;
    } catch (error) {
      return false;
    }
  }

  getState() {
    return {
      isRecording: this.isRecording,
      isProcessing: this.isProcessing,
    };
  }

  cleanup() {
    // Stop silence detection first
    this.stopSilenceDetection();

    if (this.mediaRecorder && this.isRecording) {
      this.stopRecording();
    }
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
  }
}

export default AudioManager;
