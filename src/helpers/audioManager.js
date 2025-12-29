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
const SILENCE_CHECK_INTERVAL_MS = 200; // Check every 200ms (balance between responsiveness and CPU usage)

// Adaptive silence detection settings (handles background noise)
const AMBIENT_CALIBRATION_MS = 800; // Time to measure ambient noise at start
const AMBIENT_CALIBRATION_SAMPLES = Math.ceil(
  AMBIENT_CALIBRATION_MS / SILENCE_CHECK_INTERVAL_MS,
); // ~8 samples
const AMBIENT_SKIP_INITIAL_SAMPLES = 2; // Skip first 2 samples (hotkey click noise)
const SPEECH_TO_AMBIENT_RATIO = 2.5; // Speech must be 2.5x louder than ambient to be detected
const SILENCE_TO_AMBIENT_RATIO = 1.3; // Audio must drop to within 1.3x of ambient to be "silence"
const MAX_ACCEPTABLE_AMBIENT_RMS = 0.15; // Reject environments noisier than this (~15% of full scale)
const MIN_AMBIENT_RMS = 0.003; // Floor for ambient noise (handles very quiet environments)

class AudioManager {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.isProcessing = false;
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
    // Note: API keys are not cached in renderer for security - fetched fresh each time
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

    // Adaptive ambient noise calibration
    this.ambientCalibrationSamples = []; // RMS samples during calibration
    this.ambientNoiseLevel = null; // Calculated ambient noise level
    this.isCalibrating = true; // Whether we're still in calibration phase
    this.ambientTooLoud = false; // Flag if environment is too noisy

    // Atomic state flag to prevent race conditions during stop
    this._isStopping = false;
  }

  // Get silence settings from localStorage
  getSilenceSettings() {
    const enabled = localStorage.getItem("silenceAutoStop") === "true";
    const threshold =
      parseInt(localStorage.getItem("silenceThreshold"), 10) ||
      DEFAULT_SILENCE_THRESHOLD_MS;
    return { enabled, threshold };
  }

  // Check if current audio level is silence using adaptive RMS threshold
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

    // Skip if environment was determined to be too noisy
    if (this.ambientTooLoud) {
      // Debug log to understand why silence detection isn't working
      if (!this._ambientTooLoudLogged) {
        this._ambientTooLoudLogged = true;
        console.log(
          "[AudioManager] Skipping audio check - environment too noisy",
        );
        window.electronAPI?.logReasoning?.("SILENCE_SKIPPED_TOO_LOUD", {
          reason: "Environment too noisy for silence detection",
        });
      }
      return;
    }

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

    // --- Ambient noise calibration phase ---
    if (this.isCalibrating) {
      this.ambientCalibrationSamples.push(rms);

      if (
        this.ambientCalibrationSamples.length >= AMBIENT_CALIBRATION_SAMPLES
      ) {
        // Skip initial samples (hotkey click, mic activation noise)
        const validSamples = this.ambientCalibrationSamples.slice(
          AMBIENT_SKIP_INITIAL_SAMPLES,
        );

        // Use 25th percentile (lower quartile) to avoid transient noise spikes
        // This is more robust than minimum (which could be an anomaly) or average (which is skewed by spikes)
        const sortedSamples = [...validSamples].sort((a, b) => a - b);
        const percentileIndex = Math.floor(sortedSamples.length * 0.25);
        const ambientEstimate = sortedSamples[percentileIndex];

        // Apply floor to handle very quiet environments
        this.ambientNoiseLevel = Math.max(ambientEstimate, MIN_AMBIENT_RMS);
        this.isCalibrating = false;

        // Check if environment is too noisy
        if (this.ambientNoiseLevel > MAX_ACCEPTABLE_AMBIENT_RMS) {
          this.ambientTooLoud = true;
          console.warn(
            "[AudioManager] Environment too noisy for silence detection:",
            this.ambientNoiseLevel.toFixed(4),
          );
          window.electronAPI?.logReasoning?.("AMBIENT_TOO_LOUD", {
            ambientLevel: this.ambientNoiseLevel.toFixed(4),
            maxAcceptable: MAX_ACCEPTABLE_AMBIENT_RMS,
          });
          this.onError?.({
            title: "Noisy Environment Detected",
            description:
              "Background noise is too high for auto-stop. Recording will continue normally - press hotkey to stop.",
          });
          return;
        }

        console.log("[AudioManager] Ambient calibration complete:", {
          rawSamples: this.ambientCalibrationSamples.map((s) => s.toFixed(4)),
          validSamples: validSamples.map((s) => s.toFixed(4)),
          ambientLevel: this.ambientNoiseLevel.toFixed(4),
          speechThreshold: (
            this.ambientNoiseLevel * SPEECH_TO_AMBIENT_RATIO
          ).toFixed(4),
          silenceThreshold: (
            this.ambientNoiseLevel * SILENCE_TO_AMBIENT_RATIO
          ).toFixed(4),
        });
        window.electronAPI?.logReasoning?.("AMBIENT_CALIBRATION_COMPLETE", {
          rawSamples: this.ambientCalibrationSamples.map((s) => s.toFixed(4)),
          skippedSamples: AMBIENT_SKIP_INITIAL_SAMPLES,
          ambientLevel: this.ambientNoiseLevel.toFixed(4),
          speechThreshold: (
            this.ambientNoiseLevel * SPEECH_TO_AMBIENT_RATIO
          ).toFixed(4),
          silenceThreshold: (
            this.ambientNoiseLevel * SILENCE_TO_AMBIENT_RATIO
          ).toFixed(4),
        });
      }
      return; // Still calibrating, don't check for silence yet
    }

    // --- Active silence detection with adaptive threshold ---
    const speechThreshold = this.ambientNoiseLevel * SPEECH_TO_AMBIENT_RATIO;
    const silenceThreshold = this.ambientNoiseLevel * SILENCE_TO_AMBIENT_RATIO;

    // Debug log every 3 seconds to avoid spam (every 30 checks at 100ms interval)
    if (!this._debugLogCounter) this._debugLogCounter = 0;
    this._debugLogCounter++;
    if (this._debugLogCounter % 30 === 0) {
      const logData = {
        rms: rms.toFixed(4),
        ambientLevel: this.ambientNoiseLevel?.toFixed(4),
        speechThreshold: speechThreshold.toFixed(4),
        silenceThreshold: silenceThreshold.toFixed(4),
        isSilence: rms < silenceThreshold,
        hasDetectedSpeech: this.hasDetectedSpeech,
        silenceDurationMs: this.silenceStartTime
          ? Date.now() - this.silenceStartTime
          : 0,
        configuredThresholdMs: threshold,
      };
      console.log("[AudioManager] Audio level check:", logData);
      window.electronAPI?.logReasoning?.("AUDIO_LEVEL_CHECK", logData);
    }

    // Check for silence (audio dropped back near ambient level)
    if (rms < silenceThreshold) {
      // Currently silence (relative to ambient)
      if (!this.silenceStartTime) {
        this.silenceStartTime = Date.now();
      } else if (this.hasDetectedSpeech) {
        // Only auto-stop after we've detected some speech
        const silenceDuration = Date.now() - this.silenceStartTime;
        if (silenceDuration >= threshold) {
          // Atomic check-and-set to prevent race conditions
          if (this._isStopping) {
            return; // Already stopping, don't trigger again
          }
          this._isStopping = true;

          console.log(
            "[AudioManager] Auto-stopping due to silence after",
            silenceDuration,
            "ms (ambient:",
            this.ambientNoiseLevel?.toFixed(4),
            ", current:",
            rms.toFixed(4),
            ")",
          );
          // Clear interval first to prevent re-triggering
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
      // Not silence - reset timer
      this.silenceStartTime = null;

      // Detect speech (significantly above ambient)
      if (rms > speechThreshold && !this.hasDetectedSpeech) {
        console.log(
          "[AudioManager] Speech detected, RMS:",
          rms.toFixed(4),
          "threshold:",
          speechThreshold.toFixed(4),
        );
        this.hasDetectedSpeech = true;
      }
    }
  }

  // Start monitoring audio levels for silence detection
  async startSilenceDetection(stream) {
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
    await this.stopSilenceDetection();

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

      // IMPORTANT: Resume AudioContext if suspended (required in modern browsers)
      console.log(
        "[AudioManager] AudioContext state before resume:",
        this.audioContext.state,
      );
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
        console.log("[AudioManager] AudioContext resumed successfully");
      }

      // Reset silence tracking
      this.silenceStartTime = null;
      this.hasDetectedSpeech = false;
      this._firstCheckLogged = false; // Reset debug flag for new recording
      this._debugLogCounter = 0; // Reset counter
      this._isStopping = false; // Reset atomic stop flag
      this._ambientTooLoudLogged = false; // Reset debug flag for new recording

      // Reset ambient calibration for new recording
      this.ambientCalibrationSamples = [];
      this.ambientNoiseLevel = null;
      this.isCalibrating = true;
      this.ambientTooLoud = false;

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
  async stopSilenceDetection() {
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

    // IMPORTANT: Await the close to ensure AudioContext is fully closed before creating a new one
    if (this.audioContext && this.audioContext.state !== "closed") {
      try {
        await this.audioContext.close();
      } catch {
        // Ignore close errors
      }
    }

    this.audioContext = null;
    this.analyser = null;
    this.silenceStartTime = null;
    this.hasDetectedSpeech = false;
    this.cachedSilenceSettings = null;
    this._isStopping = false; // Reset atomic stop flag

    // Reset ambient calibration state
    this.ambientCalibrationSamples = [];
    this.ambientNoiseLevel = null;
    this.isCalibrating = true;
    this.ambientTooLoud = false;
  }

  // Analyze audio blob to detect if it contains speech or is just silence
  async analyzeAudioForSpeech(audioBlob) {
    let audioContext = null;
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // Decode the audio data
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      const channelData = audioBuffer.getChannelData(0); // Get first channel

      // Calculate RMS (Root Mean Square) of the audio
      let sumSquares = 0;
      for (let i = 0; i < channelData.length; i++) {
        sumSquares += channelData[i] * channelData[i];
      }
      const rms = Math.sqrt(sumSquares / channelData.length);

      // Also calculate peak amplitude
      let peak = 0;
      for (let i = 0; i < channelData.length; i++) {
        const abs = Math.abs(channelData[i]);
        if (abs > peak) peak = abs;
      }

      // Threshold for detecting speech (adjusted for typical microphone input)
      // RMS below 0.01 is usually silence/noise, above 0.02 indicates speech
      const SPEECH_RMS_THRESHOLD = 0.015;
      const SPEECH_PEAK_THRESHOLD = 0.1;

      const hasSpeech =
        rms > SPEECH_RMS_THRESHOLD || peak > SPEECH_PEAK_THRESHOLD;

      console.log("[AudioManager] Audio analysis:", {
        rms: rms.toFixed(4),
        peak: peak.toFixed(4),
        duration: audioBuffer.duration.toFixed(2),
        hasSpeech,
        thresholds: { rms: SPEECH_RMS_THRESHOLD, peak: SPEECH_PEAK_THRESHOLD },
      });

      return hasSpeech;
    } catch (error) {
      console.error("[AudioManager] Error analyzing audio:", error);
      // If analysis fails, proceed with transcription
      return true;
    } finally {
      // Always close AudioContext to prevent memory leak
      if (audioContext && audioContext.state !== "closed") {
        try {
          await audioContext.close();
        } catch {
          // Ignore close errors
        }
      }
    }
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

        // Check if recording was cancelled (Escape key)
        if (this._cancelledRecording) {
          console.log(
            "[AudioManager] Recording was cancelled - skipping transcription",
          );
          this._cancelledRecording = false;
          this.isRecording = false;
          this.isProcessing = false;
          this.onStateChange?.({ isRecording: false, isProcessing: false });
          // Clean up stream
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        // Capture speech detection state BEFORE stopping silence detection (which clears it)
        const speechWasDetected = this.hasDetectedSpeech;
        const silenceDetectionWasEnabled =
          !!this.cachedSilenceSettings?.enabled;
        console.log(
          "[AudioManager] Speech detected:",
          speechWasDetected,
          "Silence detection enabled:",
          silenceDetectionWasEnabled,
        );

        // Stop silence detection immediately
        await this.stopSilenceDetection();

        this.isRecording = false;

        // Skip transcription if silence detection was enabled and no speech was detected
        if (silenceDetectionWasEnabled && !speechWasDetected) {
          console.log(
            "[AudioManager] No speech detected - skipping transcription",
          );
          this.isProcessing = false;
          this.onStateChange?.({ isRecording: false, isProcessing: false });
          // Clean up stream
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        const audioBlob = new Blob(this.audioChunks, { type: "audio/wav" });
        console.log("[AudioManager] audioBlob created, size:", audioBlob.size);

        if (audioBlob.size === 0) {
          console.log("[AudioManager] WARNING: audioBlob is empty!");
          this.isProcessing = false;
          this.onStateChange?.({ isRecording: false, isProcessing: false });
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        // Analyze audio for silence before transcription
        const hasAudio = await this.analyzeAudioForSpeech(audioBlob);
        if (!hasAudio) {
          console.log(
            "[AudioManager] Audio is silent - skipping transcription",
          );
          this.isProcessing = false;
          this.onStateChange?.({ isRecording: false, isProcessing: false });
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        this.isProcessing = true;
        console.log(
          "[AudioManager] Calling onStateChange with isProcessing=true",
        );
        this.onStateChange?.({ isRecording: false, isProcessing: true });

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
    // Fire-and-forget: don't await to avoid cascading async changes
    this.stopSilenceDetection().catch(() => {});

    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
      // State change will be handled in onstop callback
      return true;
    }
    return false;
  }

  // Cancel recording without processing - used for Escape key abort
  cancelRecording() {
    console.log("[AudioManager] cancelRecording called");

    // Set flag to skip processing in onstop callback
    this._cancelledRecording = true;

    // Stop silence detection (fire-and-forget)
    this.stopSilenceDetection().catch(() => {});

    if (this.mediaRecorder && this.isRecording) {
      // Stop the media recorder - onstop will check _cancelledRecording flag
      this.mediaRecorder.stop();
      return true;
    }

    // If processing, just reset state (can't cancel in-flight API call)
    if (this.isProcessing) {
      console.log(
        "[AudioManager] Cancelling during processing - resetting state",
      );
      this.isProcessing = false;
      this.onStateChange?.({ isRecording: false, isProcessing: false });
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
      const translateToEnglish =
        localStorage.getItem("translateToEnglish") === "true";
      const options = { model };
      if (language && language !== "auto") {
        options.language = language;
      }
      // Set task: "translate" converts to English, "transcribe" keeps original language
      options.task = translateToEnglish ? "translate" : "transcribe";
      console.log("[AudioManager] Transcription options:", {
        language,
        translateToEnglish,
        task: options.task,
        model,
      });
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
    // Security: Don't cache API keys in renderer process memory
    // Fetch fresh each time from main process
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

    return apiKey;
  }

  async optimizeAudio(audioBlob) {
    return new Promise((resolve) => {
      const audioContext = new (
        window.AudioContext || window.webkitAudioContext
      )();
      const reader = new FileReader();

      // Helper to close AudioContext and resolve (prevents memory leak)
      const closeAndResolve = (result) => {
        audioContext.close().catch(() => {});
        resolve(result);
      };

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
          closeAndResolve(wavBlob);
        } catch (error) {
          // If optimization fails, use original
          closeAndResolve(audioBlob);
        }
      };

      reader.onerror = () => closeAndResolve(audioBlob);
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
          const translateToEnglish =
            localStorage.getItem("translateToEnglish") === "true";
          const options = { model: fallbackModel };
          if (language && language !== "auto") {
            options.language = language;
          }
          options.task = translateToEnglish ? "translate" : "transcribe";

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
    // Stop silence detection first (fire-and-forget)
    this.stopSilenceDetection().catch(() => {});

    if (this.mediaRecorder && this.isRecording) {
      this.stopRecording();
    }
    this.onStateChange = null;
    this.onError = null;
    this.onTranscriptionComplete = null;
  }
}

export default AudioManager;
