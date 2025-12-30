const { spawn } = require("child_process");
const fs = require("fs");
const fsPromises = require("fs").promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const PythonInstaller = require("./pythonInstaller");
const { runCommand, TIMEOUTS } = require("../utils/process");
const debugLogger = require("./debugLogger");

class WhisperManager {
  constructor() {
    this.pythonCmd = null;
    this.whisperInstalled = null;
    this.isInitialized = false;
    this.currentDownloadProcess = null;
    this.pythonInstaller = new PythonInstaller();
    this.cachedFFmpegPath = null;

    // Server mode state
    this.serverProcess = null;
    this.serverReady = false;
    this.serverModel = null;
    this.isStarting = false; // Prevents concurrent start calls
    this.pendingRequests = new Map(); // requestId -> { resolve, reject }
    this.requestIdCounter = 0;
    this.serverStdoutBuffer = "";
  }

  // --- Server Mode Methods ---

  async startServer(modelName = "base") {
    // If server is already running with the same model, do nothing
    if (
      this.serverProcess &&
      this.serverReady &&
      this.serverModel === modelName
    ) {
      debugLogger.log(
        `Whisper server already running with model '${modelName}'`,
      );
      return { success: true, model: modelName };
    }

    // If another start is in progress, wait for it
    if (this.isStarting) {
      debugLogger.log(
        `Whisper server already starting, waiting for it to complete...`,
      );
      // Wait up to 60 seconds for the other start to complete
      const maxWait = 60000;
      const checkInterval = 100;
      let waited = 0;
      while (this.isStarting && waited < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
        waited += checkInterval;
      }
      // Check again after waiting
      if (
        this.serverProcess &&
        this.serverReady &&
        this.serverModel === modelName
      ) {
        return { success: true, model: modelName };
      }
    }

    // Stop existing server if running with different model
    if (this.serverProcess) {
      await this.stopServer();
    }

    const pythonCmd = await this.findPythonExecutable();
    const whisperScriptPath = this.getWhisperScriptPath();
    const ffmpegPath = await this.getFFmpegPath();

    if (!fs.existsSync(whisperScriptPath)) {
      throw new Error(`Whisper script not found at: ${whisperScriptPath}`);
    }

    const args = [whisperScriptPath, "--mode", "server", "--model", modelName];

    const absoluteFFmpegPath = ffmpegPath ? path.resolve(ffmpegPath) : "";
    const enhancedEnv = {
      ...process.env,
      FFMPEG_PATH: absoluteFFmpegPath,
      FFMPEG_EXECUTABLE: absoluteFFmpegPath,
      FFMPEG_BINARY: absoluteFFmpegPath,
    };

    // Add ffmpeg to PATH
    if (ffmpegPath) {
      const ffmpegDir = path.dirname(ffmpegPath);
      const pathSeparator = process.platform === "win32" ? ";" : ":";
      const currentPath = enhancedEnv.PATH || "";
      if (!currentPath.includes(ffmpegDir)) {
        enhancedEnv.PATH = `${ffmpegDir}${pathSeparator}${currentPath}`;
      }
    }

    console.log(`[whisper] Starting server with model '${modelName}'...`);
    debugLogger.log(`Starting Whisper server with model '${modelName}'`);

    return new Promise((resolve, reject) => {
      // Set starting flag to prevent concurrent starts
      this.isStarting = true;

      this.serverProcess = spawn(pythonCmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: enhancedEnv,
      });

      this.serverReady = false;
      this.serverModel = modelName;
      this.serverStdoutBuffer = "";

      // Handle stdout - parse JSON responses
      this.serverProcess.stdout.on("data", (data) => {
        this.handleServerOutput(data.toString());
      });

      // Handle stderr - log all messages for debugging
      this.serverProcess.stderr.on("data", (data) => {
        const text = data.toString();
        console.log("[whisper-stderr]", text.trim());
        debugLogger.logProcessOutput("Whisper Server", "stderr", data);
      });

      this.serverProcess.on("close", (code) => {
        console.log(`[whisper] Server process exited with code ${code}`);
        debugLogger.log(`Whisper server exited with code ${code}`);
        this.serverProcess = null;
        this.serverReady = false;
        this.serverModel = null;
        this.isStarting = false; // Clear starting flag

        // Reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error("Server process exited unexpectedly"));
        }
        this.pendingRequests.clear();
      });

      this.serverProcess.on("error", (error) => {
        console.error("[whisper] Server process error:", error);
        debugLogger.error("Whisper server error:", error);
        this.serverProcess = null;
        this.serverReady = false;
        this.isStarting = false; // Clear starting flag on error
        reject(error);
      });

      // Wait for server ready signal with timeout
      const startTimeout = setTimeout(() => {
        if (!this.serverReady) {
          this.isStarting = false; // Clear starting flag on timeout
          this.stopServer();
          reject(new Error("Server startup timed out (60 seconds)"));
        }
      }, 60000);

      // Listen for ready signal
      const checkReady = (response) => {
        if (response.type === "ready") {
          clearTimeout(startTimeout);
          this.serverReady = true;
          this.isStarting = false; // Clear starting flag on success
          console.log(`[whisper] Server ready with model '${modelName}'`);
          resolve({ success: true, model: modelName });
          return true;
        }
        return false;
      };

      // Store the ready check to be called by handleServerOutput
      this._onReadyCallback = checkReady;
    });
  }

  handleServerOutput(data) {
    this.serverStdoutBuffer += data;
    const lines = this.serverStdoutBuffer.split("\n");

    // Process complete lines
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const response = JSON.parse(line);

        // Validate response is a non-null object to prevent prototype pollution or type confusion
        if (
          response === null ||
          typeof response !== "object" ||
          Array.isArray(response)
        ) {
          debugLogger.warn("Invalid server response type:", typeof response);
          continue;
        }

        // Check for ready signal during startup
        if (this._onReadyCallback && this._onReadyCallback(response)) {
          this._onReadyCallback = null;
          continue;
        }

        // Handle transcription response
        if (response.success !== undefined || response.error !== undefined) {
          // This is a transcription result - resolve the pending request
          const pending = this.pendingRequests.get(0); // We use 0 as we process one at a time
          if (pending) {
            this.pendingRequests.delete(0);
            if (response.success) {
              pending.resolve(response);
            } else {
              pending.reject(
                new Error(response.error || "Transcription failed"),
              );
            }
          }
        }
      } catch (parseError) {
        debugLogger.error("Failed to parse server response:", line, parseError);
      }
    }

    // Keep incomplete line in buffer
    this.serverStdoutBuffer = lines[lines.length - 1];
  }

  async stopServer() {
    if (!this.serverProcess) {
      return { success: true, message: "Server not running" };
    }

    console.log("[whisper] Stopping server...");
    debugLogger.log("Stopping Whisper server");

    return new Promise((resolve) => {
      let resolved = false;
      const cleanupAndResolve = (message) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(forceKillTimeout);
        clearTimeout(maxWaitTimeout);
        this.serverProcess = null;
        this.serverReady = false;
        this.serverModel = null;
        this.isStarting = false; // Clear starting flag when stopping
        resolve({ success: true, message });
      };

      // Send shutdown command
      try {
        this.serverProcess.stdin.write(
          JSON.stringify({ command: "shutdown" }) + "\n",
        );
      } catch (e) {
        // Stdin might be closed already
      }

      // Force kill after 5 seconds if graceful shutdown doesn't work
      const forceKillTimeout = setTimeout(() => {
        if (this.serverProcess && !resolved) {
          console.log("[whisper] Force killing server process...");
          try {
            this.serverProcess.kill("SIGKILL");
          } catch (e) {
            // Process might already be dead
          }
        }
      }, 5000);

      // Maximum wait time (10 seconds) - resolve regardless of process state
      // This prevents hanging if process becomes a zombie
      const maxWaitTimeout = setTimeout(() => {
        if (!resolved) {
          console.warn("[whisper] Server stop timed out - cleaning up anyway");
          cleanupAndResolve("Server stop timed out");
        }
      }, 10000);

      this.serverProcess.on("close", () => {
        cleanupAndResolve("Server stopped");
      });
    });
  }

  async transcribeWithServer(audioPath, language = null) {
    if (!this.serverProcess || !this.serverReady) {
      throw new Error("Server not running");
    }

    return new Promise((resolve, reject) => {
      const request = {
        command: "transcribe",
        audio_path: audioPath,
      };

      if (language) {
        request.language = language;
      }

      // Store pending request
      this.pendingRequests.set(0, { resolve, reject });

      // Send request to server
      try {
        this.serverProcess.stdin.write(JSON.stringify(request) + "\n");
      } catch (error) {
        this.pendingRequests.delete(0);
        reject(new Error(`Failed to send request to server: ${error.message}`));
      }

      // Timeout for transcription
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(0)) {
          this.pendingRequests.delete(0);
          reject(new Error("Transcription request timed out (120 seconds)"));
        }
      }, 120000);

      // Clear timeout when resolved
      const originalResolve = resolve;
      const originalReject = reject;
      this.pendingRequests.set(0, {
        resolve: (result) => {
          clearTimeout(timeout);
          originalResolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          originalReject(error);
        },
      });
    });
  }

  async reloadServerModel(modelName) {
    if (!this.serverProcess || !this.serverReady) {
      // Server not running, just start it with the new model
      return this.startServer(modelName);
    }

    if (this.serverModel === modelName) {
      return { success: true, model: modelName };
    }

    console.log(`[whisper] Reloading server with model '${modelName}'...`);

    return new Promise((resolve, reject) => {
      const request = {
        command: "reload",
        model: modelName,
      };

      // Store pending request
      this.pendingRequests.set(0, {
        resolve: (result) => {
          if (result.type === "reloaded") {
            this.serverModel = modelName;
            console.log(`[whisper] Server reloaded with model '${modelName}'`);
          }
          resolve(result);
        },
        reject,
      });

      try {
        this.serverProcess.stdin.write(JSON.stringify(request) + "\n");
      } catch (error) {
        this.pendingRequests.delete(0);
        reject(new Error(`Failed to reload model: ${error.message}`));
      }

      // Timeout for reload
      setTimeout(() => {
        if (this.pendingRequests.has(0)) {
          this.pendingRequests.delete(0);
          reject(new Error("Model reload timed out (60 seconds)"));
        }
      }, 60000);
    });
  }

  isServerRunning() {
    return this.serverProcess !== null && this.serverReady;
  }

  getServerModel() {
    return this.serverModel;
  }

  // --- End Server Mode Methods ---

  sanitizeErrorMessage(message = "") {
    if (!message) {
      return "";
    }
    return message.replace(/\x1B\[[0-9;]*m/g, "");
  }

  shouldRetryWithUserInstall(message = "") {
    const normalized = this.sanitizeErrorMessage(message).toLowerCase();
    const shouldUseUser =
      normalized.includes("permission denied") ||
      normalized.includes("access is denied") ||
      normalized.includes("externally-managed-environment") ||
      normalized.includes("externally managed environment") ||
      normalized.includes("pep 668") ||
      normalized.includes("--break-system-packages");
    return shouldUseUser;
  }

  isTomlResolverError(message = "") {
    const normalized = this.sanitizeErrorMessage(message).toLowerCase();
    return (
      normalized.includes("pyproject.toml") || normalized.includes("tomlerror")
    );
  }

  formatWhisperInstallError(message = "") {
    let formatted =
      this.sanitizeErrorMessage(message) || "Whisper installation failed.";
    const lower = formatted.toLowerCase();

    if (lower.includes("microsoft visual c++")) {
      return "Microsoft Visual C++ build tools required. Install Visual Studio Build Tools.";
    }

    if (lower.includes("no matching distribution")) {
      return "Python version incompatible. OpenAI Whisper requires Python 3.8-3.11.";
    }

    return formatted;
  }

  getWhisperScriptPath() {
    // In production, the file is unpacked from ASAR
    if (process.env.NODE_ENV === "development") {
      return path.join(__dirname, "..", "..", "whisper_bridge.py");
    } else {
      // In production, use the unpacked path
      return path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "whisper_bridge.py",
      );
    }
  }

  async initializeAtStartup(settings = {}) {
    try {
      await this.findPythonExecutable();
      await this.checkWhisperInstallation();
      this.isInitialized = true;

      // If local Whisper is enabled and a model is set, preload it into GPU
      const { useLocalWhisper, whisperModel } = settings;
      if (useLocalWhisper && whisperModel) {
        console.log(
          `[whisper] Preloading model '${whisperModel}' at startup...`,
        );
        try {
          await this.startServer(whisperModel);
          console.log(
            `[whisper] Model '${whisperModel}' preloaded successfully`,
          );
        } catch (serverError) {
          console.error(
            "[whisper] Failed to preload model at startup:",
            serverError.message,
          );
          // Don't fail startup if server fails to start - transcription will still work in non-server mode
        }
      }
    } catch (error) {
      // Whisper not available at startup is not critical
      this.isInitialized = true;
    }
  }

  async transcribeLocalWhisper(audioBlob, options = {}) {
    debugLogger.logWhisperPipeline("transcribeLocalWhisper - start", {
      options,
      audioBlobType: audioBlob?.constructor?.name,
      audioBlobSize: audioBlob?.byteLength || audioBlob?.size || 0,
      serverRunning: this.isServerRunning(),
      serverModel: this.serverModel,
    });

    // First check if FFmpeg is available
    const ffmpegCheck = await this.checkFFmpegAvailability();
    debugLogger.logWhisperPipeline("FFmpeg availability check", ffmpegCheck);

    if (!ffmpegCheck.available) {
      debugLogger.error("FFmpeg not available", ffmpegCheck);
      throw new Error(
        `FFmpeg not available: ${ffmpegCheck.error || "Unknown error"}`,
      );
    }

    const tempAudioPath = await this.createTempAudioFile(audioBlob);
    const model = options.model || "base";
    const language = options.language || null;

    try {
      // Use server mode if running, otherwise fall back to spawning new process
      if (this.isServerRunning()) {
        // If model changed, reload it
        if (this.serverModel !== model) {
          console.log(
            `[whisper] Model changed from '${this.serverModel}' to '${model}', reloading...`,
          );
          await this.reloadServerModel(model);
        }

        debugLogger.log("Using server mode for transcription");
        const result = await this.transcribeWithServer(tempAudioPath, language);

        if (!result.text || result.text.trim().length === 0) {
          return { success: false, message: "No audio detected" };
        }

        // Remove carriage returns that can cause paste issues on Linux
        const cleanText = result.text.trim().replace(/\r/g, "");
        return { success: true, text: cleanText };
      } else {
        // Fall back to spawning new process (slow path)
        debugLogger.log(
          "Server not running, using process spawn for transcription",
        );
        const result = await this.runWhisperProcess(
          tempAudioPath,
          model,
          language,
        );
        return this.parseWhisperResult(result);
      }
    } catch (error) {
      throw error;
    } finally {
      await this.cleanupTempFile(tempAudioPath);
    }
  }

  async createTempAudioFile(audioBlob) {
    const tempDir = os.tmpdir();
    const filename = `whisper_audio_${crypto.randomUUID()}.wav`;
    const tempAudioPath = path.join(tempDir, filename);

    // Security: Validate the resolved path stays within tmpdir (prevent path traversal)
    const resolvedPath = path.resolve(tempAudioPath);
    const resolvedTempDir = path.resolve(tempDir);
    if (!resolvedPath.startsWith(resolvedTempDir + path.sep)) {
      throw new Error("Invalid temp file path: path traversal detected");
    }

    debugLogger.logAudioData("createTempAudioFile", audioBlob);
    debugLogger.log("Creating temp file at:", tempAudioPath);

    let buffer;
    if (audioBlob instanceof ArrayBuffer) {
      buffer = Buffer.from(audioBlob);
    } else if (audioBlob instanceof Uint8Array) {
      buffer = Buffer.from(audioBlob);
    } else if (typeof audioBlob === "string") {
      buffer = Buffer.from(audioBlob, "base64");
    } else if (audioBlob && audioBlob.buffer) {
      buffer = Buffer.from(audioBlob.buffer);
    } else {
      debugLogger.error(
        "Unsupported audio data type:",
        typeof audioBlob,
        audioBlob,
      );
      throw new Error(`Unsupported audio data type: ${typeof audioBlob}`);
    }

    debugLogger.log("Buffer created, size:", buffer.length);

    await fsPromises.writeFile(tempAudioPath, buffer);

    // Verify file was written correctly
    const stats = await fsPromises.stat(tempAudioPath);
    const fileInfo = {
      path: tempAudioPath,
      size: stats.size,
      isFile: stats.isFile(),
      permissions: stats.mode.toString(8),
    };
    debugLogger.logWhisperPipeline("Temp audio file created", fileInfo);

    if (stats.size === 0) {
      debugLogger.error("Audio file is empty after writing");
      throw new Error("Audio file is empty");
    }

    return tempAudioPath;
  }

  async getFFmpegPath() {
    if (this.cachedFFmpegPath) {
      return this.cachedFFmpegPath;
    }

    let ffmpegPath;

    try {
      ffmpegPath = require("ffmpeg-static");
      debugLogger.logFFmpegDebug("Initial ffmpeg-static path", ffmpegPath);

      if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) {
        ffmpegPath += ".exe";
      }

      if (
        process.env.NODE_ENV !== "development" &&
        !fs.existsSync(ffmpegPath)
      ) {
        const possiblePaths = [
          ffmpegPath.replace("app.asar", "app.asar.unpacked"),
          ffmpegPath.replace(
            /.*app\.asar/,
            path.join(__dirname, "..", "..", "app.asar.unpacked"),
          ),
          path.join(
            process.resourcesPath,
            "app.asar.unpacked",
            "node_modules",
            "ffmpeg-static",
            process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
          ),
        ];

        debugLogger.log(
          "FFmpeg not found at primary path, checking alternatives",
        );

        for (const possiblePath of possiblePaths) {
          if (fs.existsSync(possiblePath)) {
            ffmpegPath = possiblePath;
            debugLogger.log("FFmpeg found at:", ffmpegPath);
            break;
          }
        }
      }

      if (!fs.existsSync(ffmpegPath)) {
        debugLogger.error("Bundled FFmpeg not found at:", ffmpegPath);
        throw new Error(`Bundled FFmpeg not found at ${ffmpegPath}`);
      }

      try {
        fs.accessSync(ffmpegPath, fs.constants.X_OK);
        debugLogger.log("FFmpeg is executable");
      } catch (e) {
        debugLogger.error("FFmpeg exists but is not executable:", e.message);
        throw new Error(`FFmpeg exists but is not executable: ${ffmpegPath}`);
      }
    } catch (e) {
      debugLogger.log("Bundled FFmpeg not available, trying system FFmpeg");

      const systemFFmpeg =
        process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

      try {
        const versionResult = await runCommand(systemFFmpeg, ["--version"], {
          timeout: TIMEOUTS.QUICK_CHECK,
        });
        ffmpegPath = systemFFmpeg;
        debugLogger.log("Using system FFmpeg");
      } catch (systemError) {
        debugLogger.error(
          "System FFmpeg also unavailable:",
          systemError.message,
        );
        ffmpegPath = systemFFmpeg;
      }
    }

    this.cachedFFmpegPath = ffmpegPath;
    return ffmpegPath;
  }

  async runWhisperProcess(tempAudioPath, model, language) {
    const pythonCmd = await this.findPythonExecutable();
    const whisperScriptPath = this.getWhisperScriptPath();

    if (!fs.existsSync(whisperScriptPath)) {
      throw new Error(`Whisper script not found at: ${whisperScriptPath}`);
    }

    const args = [whisperScriptPath, tempAudioPath, "--model", model];
    if (language) {
      args.push("--language", language);
    }
    args.push("--output-format", "json");

    return new Promise(async (resolve, reject) => {
      let ffmpegPath = await this.getFFmpegPath();
      const absoluteFFmpegPath = path.resolve(ffmpegPath);
      const enhancedEnv = {
        ...process.env,
        FFMPEG_PATH: absoluteFFmpegPath,
        FFMPEG_EXECUTABLE: absoluteFFmpegPath,
        FFMPEG_BINARY: absoluteFFmpegPath,
      };

      debugLogger.logFFmpegDebug("Setting FFmpeg env vars", absoluteFFmpegPath);

      // Add ffmpeg directory to PATH if we have a valid path
      if (ffmpegPath) {
        const ffmpegDir = path.dirname(ffmpegPath);
        const currentPath = enhancedEnv.PATH || "";
        const pathSeparator = process.platform === "win32" ? ";" : ":";

        if (!currentPath.includes(ffmpegDir)) {
          enhancedEnv.PATH = `${ffmpegDir}${pathSeparator}${currentPath}`;
        }

        // CRITICAL: Also create a symlink or use the actual unpacked path
        // The issue is that the ffmpeg path points to the ASAR archive, but we need the unpacked version
        if (
          ffmpegPath.includes("app.asar") &&
          !ffmpegPath.includes("app.asar.unpacked")
        ) {
          const unpackedPath = ffmpegPath.replace(
            "app.asar",
            "app.asar.unpacked",
          );
          if (fs.existsSync(unpackedPath)) {
            ffmpegPath = unpackedPath;
            enhancedEnv.FFMPEG_PATH = unpackedPath;
            enhancedEnv.FFMPEG_EXECUTABLE = unpackedPath;
            enhancedEnv.FFMPEG_BINARY = unpackedPath;
            // Update PATH with the unpacked directory
            const unpackedDir = path.dirname(unpackedPath);
            enhancedEnv.PATH = `${unpackedDir}${pathSeparator}${currentPath}`;
            debugLogger.log("Using unpacked FFmpeg path:", unpackedPath);
          }
        }
      } else {
        debugLogger.error("No valid FFmpeg path found, transcription may fail");
      }

      // Add common system paths for macOS GUI launches
      if (process.platform === "darwin") {
        const commonPaths = [
          "/usr/local/bin",
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ];

        const currentPath = enhancedEnv.PATH || "";
        const pathsToAdd = commonPaths.filter((p) => !currentPath.includes(p));

        if (pathsToAdd.length > 0) {
          enhancedEnv.PATH = `${currentPath}:${pathsToAdd.join(":")}`;
          debugLogger.log("Added system paths for GUI launch");
        }
      }

      const envDebugInfo = {
        FFMPEG_PATH: enhancedEnv.FFMPEG_PATH,
        PATH_includes_ffmpeg: enhancedEnv.PATH?.includes(
          path.dirname(ffmpegPath || ""),
        ),
        pythonCmd,
        args: args.join(" "),
      };
      debugLogger.logProcessStart(pythonCmd, args, { env: enhancedEnv });

      const whisperProcess = spawn(pythonCmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: enhancedEnv,
      });

      let stdout = "";
      let stderr = "";
      let isResolved = false;

      // Set timeout for transcription (2 minutes should be sufficient for most recordings)
      const timeout = setTimeout(() => {
        if (!isResolved) {
          whisperProcess.kill("SIGTERM");
          reject(new Error("Whisper transcription timed out (120 seconds)"));
        }
      }, 120000); // 120 seconds = 2 minutes

      whisperProcess.stdout.on("data", (data) => {
        stdout += data.toString();
        debugLogger.logProcessOutput("Whisper", "stdout", data);
      });

      whisperProcess.stderr.on("data", (data) => {
        const stderrText = data.toString();
        stderr += stderrText;

        // Show whisper_bridge messages in terminal
        if (stderrText.includes("[whisper_bridge]")) {
          console.log(stderrText.trim());
        }

        debugLogger.logProcessOutput("Whisper", "stderr", data);
      });

      whisperProcess.on("close", (code) => {
        if (isResolved) return;
        isResolved = true;
        clearTimeout(timeout);

        debugLogger.logWhisperPipeline("Process closed", {
          code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });

        if (code === 0) {
          debugLogger.log("Transcription successful");
          resolve(stdout);
        } else {
          // Better error message for FFmpeg issues
          let errorMessage = `Whisper transcription failed (code ${code}): ${stderr}`;

          if (
            stderr.includes("ffmpeg") ||
            stderr.includes("No such file or directory") ||
            stderr.includes("FFmpeg not found")
          ) {
            errorMessage +=
              "\n\nFFmpeg issue detected. Try restarting the app or reinstalling.";
          }

          reject(new Error(errorMessage));
        }
      });

      whisperProcess.on("error", (error) => {
        if (isResolved) return;
        isResolved = true;
        clearTimeout(timeout);

        if (error.code === "ENOENT") {
          const platformHelp =
            process.platform === "win32"
              ? 'Install Python 3.11+ from python.org with the "Install launcher" option, or set OPENWHISPR_PYTHON to the full path (for example C:\\\\Python312\\\\python.exe).'
              : "Install Python 3.11+ (for example `brew install python@3.11`) or set OPENWHISPR_PYTHON to the interpreter you want OpenWhispr to use.";
          const fallbackHelp =
            "You can also disable Local Whisper or enable the OpenAI fallback in Settings to continue using cloud transcription.";
          const message = [
            "Local Whisper could not start because Python was not found on this system.",
            platformHelp,
            fallbackHelp,
          ].join(" ");
          reject(new Error(message));
          return;
        }

        reject(new Error(`Whisper process error: ${error.message}`));
      });
    });
  }

  parseWhisperResult(stdout) {
    debugLogger.logWhisperPipeline("Parsing result", {
      stdoutLength: stdout.length,
    });
    try {
      // Clean stdout by removing any non-JSON content
      const lines = stdout.split("\n").filter((line) => line.trim());
      let jsonLine = "";

      // Find the line that looks like JSON (starts with { and ends with })
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          jsonLine = trimmed;
          break;
        }
      }

      if (!jsonLine) {
        throw new Error("No JSON output found in Whisper response");
      }

      const result = JSON.parse(jsonLine);

      if (!result.text || result.text.trim().length === 0) {
        return { success: false, message: "No audio detected" };
      }
      // Remove carriage returns that can cause paste issues on Linux
      const cleanText = result.text.trim().replace(/\r/g, "");
      return { success: true, text: cleanText };
    } catch (parseError) {
      debugLogger.error("Failed to parse Whisper output");
      throw new Error(`Failed to parse Whisper output: ${parseError.message}`);
    }
  }

  async cleanupTempFile(tempAudioPath) {
    try {
      await fsPromises.unlink(tempAudioPath);
    } catch (cleanupError) {
      // Temp file cleanup error is not critical
    }
  }

  async findPythonExecutable() {
    if (this.pythonCmd) {
      return this.pythonCmd;
    }

    const candidateSet = new Set();
    const addCandidate = (candidate) => {
      if (!candidate || typeof candidate !== "string") {
        return;
      }
      const sanitized = candidate.trim().replace(/^["']|["']$/g, "");
      if (sanitized.length === 0) {
        return;
      }
      candidateSet.add(sanitized);
    };

    if (process.env.OPENWHISPR_PYTHON) {
      addCandidate(process.env.OPENWHISPR_PYTHON);
    }

    if (process.platform === "win32") {
      this.getWindowsPythonCandidates().forEach(addCandidate);
    }

    const commonCandidates = [
      "python3.12",
      "python3.11",
      "python3.10",
      "python3",
      "python",
      "/usr/bin/python3.12",
      "/usr/bin/python3.11",
      "/usr/bin/python3.10",
      "/usr/bin/python3",
      "/usr/local/bin/python3.12",
      "/usr/local/bin/python3.11",
      "/usr/local/bin/python3.10",
      "/usr/local/bin/python3",
      "/opt/homebrew/bin/python3.12",
      "/opt/homebrew/bin/python3.11",
      "/opt/homebrew/bin/python3.10",
      "/opt/homebrew/bin/python3",
      "/usr/bin/python",
      "/usr/local/bin/python",
    ];
    commonCandidates.forEach(addCandidate);

    for (const pythonPath of candidateSet) {
      if (path.isAbsolute(pythonPath) && !fs.existsSync(pythonPath)) {
        continue;
      }

      try {
        const version = await this.getPythonVersion(pythonPath);
        if (this.isPythonVersionSupported(version)) {
          this.pythonCmd = pythonPath;
          return pythonPath;
        }
      } catch (error) {
        continue;
      }
    }

    throw new Error(
      'Python 3.x not found. Click "Install Python" in Settings or set OPENWHISPR_PYTHON to a valid interpreter path.',
    );
  }

  getWindowsPythonCandidates() {
    const candidates = [];
    const versionSuffixes = ["313", "312", "311", "310", "39", "38"];

    const systemDrive = process.env.SystemDrive || "C:";
    const windowsDir = process.env.WINDIR || path.join(systemDrive, "Windows");

    candidates.push("py");
    candidates.push("py.exe");
    candidates.push("python3");
    candidates.push("python3.exe");
    candidates.push("python");
    candidates.push("python.exe");
    candidates.push(path.join(windowsDir, "py.exe"));

    const baseDirs = [];
    if (process.env.LOCALAPPDATA) {
      baseDirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python"));
      const windowsApps = path.join(
        process.env.LOCALAPPDATA,
        "Microsoft",
        "WindowsApps",
      );
      candidates.push(path.join(windowsApps, "python.exe"));
      candidates.push(path.join(windowsApps, "python3.exe"));
    }
    if (process.env.ProgramFiles) {
      baseDirs.push(process.env.ProgramFiles);
    }
    if (process.env["ProgramFiles(x86)"]) {
      baseDirs.push(process.env["ProgramFiles(x86)"]);
    }
    baseDirs.push(systemDrive);

    for (const baseDir of baseDirs) {
      if (!baseDir) {
        continue;
      }

      for (const suffix of versionSuffixes) {
        const folderName = `Python${suffix}`;
        candidates.push(path.join(baseDir, folderName, "python.exe"));
      }
    }

    return candidates;
  }

  async installPython(progressCallback = null) {
    try {
      // Clear cached Python command since we're installing new one
      this.pythonCmd = null;

      const result = await this.pythonInstaller.installPython(progressCallback);

      // After installation, try to find Python again
      try {
        await this.findPythonExecutable();
        return result;
      } catch (findError) {
        throw new Error(
          "Python installed but not found in PATH. Please restart the application.",
        );
      }
    } catch (error) {
      console.error("Python installation failed:", error);
      throw error;
    }
  }

  async checkPythonInstallation() {
    return await this.pythonInstaller.isPythonInstalled();
  }

  async getPythonVersion(pythonPath) {
    return new Promise((resolve) => {
      const testProcess = spawn(pythonPath, ["--version"]);
      let output = "";

      testProcess.stdout.on("data", (data) => (output += data));
      testProcess.stderr.on("data", (data) => (output += data));

      testProcess.on("close", (code) => {
        if (code === 0) {
          const match = output.match(/Python (\d+)\.(\d+)/i);
          resolve(match ? { major: +match[1], minor: +match[2] } : null);
        } else {
          resolve(null);
        }
      });

      testProcess.on("error", () => resolve(null));
    });
  }

  isPythonVersionSupported(version) {
    // Accept any Python 3.x version
    return version && version.major === 3;
  }

  async checkWhisperInstallation() {
    // Return cached result if available
    if (this.whisperInstalled !== null) {
      return this.whisperInstalled;
    }

    try {
      const pythonCmd = await this.findPythonExecutable();

      const result = await new Promise((resolve) => {
        const checkProcess = spawn(pythonCmd, [
          "-c",
          'import whisper; print("OK")',
        ]);

        let output = "";
        checkProcess.stdout.on("data", (data) => {
          output += data.toString();
        });

        checkProcess.on("close", (code) => {
          if (code === 0 && output.includes("OK")) {
            resolve({ installed: true, working: true });
          } else {
            resolve({ installed: false, working: false });
          }
        });

        checkProcess.on("error", (error) => {
          resolve({ installed: false, working: false, error: error.message });
        });
      });

      this.whisperInstalled = result; // Cache the result
      return result;
    } catch (error) {
      const errorResult = {
        installed: false,
        working: false,
        error: error.message,
      };
      this.whisperInstalled = errorResult;
      return errorResult;
    }
  }

  async checkFFmpegAvailability() {
    debugLogger.logWhisperPipeline("checkFFmpegAvailability - start", {});

    try {
      const pythonCmd = await this.findPythonExecutable();
      const whisperScriptPath = this.getWhisperScriptPath();
      const ffmpegPath = await this.getFFmpegPath();

      const result = await new Promise((resolve) => {
        const env = {
          ...process.env,
          FFMPEG_PATH: ffmpegPath || "",
          FFMPEG_EXECUTABLE: ffmpegPath || "",
          FFMPEG_BINARY: ffmpegPath || "",
        };

        const checkProcess = spawn(
          pythonCmd,
          [whisperScriptPath, "--mode", "check-ffmpeg"],
          {
            env: env,
          },
        );

        let output = "";
        let stderr = "";

        checkProcess.stdout.on("data", (data) => {
          output += data.toString();
        });

        checkProcess.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        checkProcess.on("close", (code) => {
          debugLogger.logWhisperPipeline("FFmpeg check process closed", {
            code,
            outputLength: output.length,
            stderrLength: stderr.length,
          });

          if (code === 0) {
            try {
              const result = JSON.parse(output);
              debugLogger.log("FFmpeg check result:", result);
              resolve(result);
            } catch (parseError) {
              debugLogger.error(
                "Failed to parse FFmpeg check result:",
                parseError,
              );
              resolve({
                available: false,
                error: "Failed to parse FFmpeg check result",
              });
            }
          } else {
            debugLogger.error(
              "FFmpeg check failed with code:",
              code,
              "stderr:",
              stderr,
            );
            resolve({
              available: false,
              error: stderr || "FFmpeg check failed",
            });
          }
        });

        checkProcess.on("error", (error) => {
          resolve({ available: false, error: error.message });
        });
      });

      return result;
    } catch (error) {
      return { available: false, error: error.message };
    }
  }

  upgradePip(pythonCmd) {
    return runCommand(pythonCmd, ["-m", "pip", "install", "--upgrade", "pip"], {
      timeout: TIMEOUTS.PIP_UPGRADE,
    });
  }

  // Removed - now using shared runCommand from utils/process.js

  async installWhisper() {
    const pythonCmd = await this.findPythonExecutable();

    // Upgrade pip first to avoid version issues
    try {
      await this.upgradePip(pythonCmd);
    } catch (error) {
      const cleanUpgradeError = this.sanitizeErrorMessage(error.message);
      debugLogger.log("First pip upgrade attempt failed:", cleanUpgradeError);

      // Try user install for pip upgrade
      try {
        await runCommand(
          pythonCmd,
          ["-m", "pip", "install", "--user", "--upgrade", "pip"],
          { timeout: TIMEOUTS.PIP_UPGRADE },
        );
      } catch (userError) {
        const cleanUserError = this.sanitizeErrorMessage(userError.message);
        // If pip upgrade fails completely, try to detect if it's the TOML error
        if (
          this.isTomlResolverError(cleanUpgradeError) ||
          this.isTomlResolverError(cleanUserError)
        ) {
          // Try installing with legacy resolver as a workaround
          try {
            await runCommand(
              pythonCmd,
              [
                "-m",
                "pip",
                "install",
                "--use-deprecated=legacy-resolver",
                "--upgrade",
                "pip",
              ],
              { timeout: TIMEOUTS.PIP_UPGRADE },
            );
          } catch (legacyError) {
            throw new Error(
              "Failed to upgrade pip. Please manually run: python -m pip install --upgrade pip",
            );
          }
        } else {
          debugLogger.log(
            "Pip upgrade failed completely, attempting to continue",
          );
        }
      }
    }

    const buildInstallArgs = ({ user = false, legacy = false } = {}) => {
      const args = ["-m", "pip", "install"];
      if (legacy) {
        args.push("--use-deprecated=legacy-resolver");
      }
      if (user) {
        args.push("--user");
      }
      args.push("-U", "faster-whisper");
      return args;
    };

    try {
      return await runCommand(pythonCmd, buildInstallArgs(), {
        timeout: TIMEOUTS.DOWNLOAD,
      });
    } catch (error) {
      const cleanMessage = this.sanitizeErrorMessage(error.message);

      if (this.shouldRetryWithUserInstall(cleanMessage)) {
        try {
          return await runCommand(pythonCmd, buildInstallArgs({ user: true }), {
            timeout: TIMEOUTS.DOWNLOAD,
          });
        } catch (userError) {
          const userMessage = this.sanitizeErrorMessage(userError.message);
          if (this.isTomlResolverError(userMessage)) {
            return await runCommand(
              pythonCmd,
              buildInstallArgs({ user: true, legacy: true }),
              { timeout: TIMEOUTS.DOWNLOAD },
            );
          }
          throw new Error(this.formatWhisperInstallError(userMessage));
        }
      }

      if (this.isTomlResolverError(cleanMessage)) {
        try {
          return await runCommand(
            pythonCmd,
            buildInstallArgs({ legacy: true }),
            { timeout: TIMEOUTS.DOWNLOAD },
          );
        } catch (legacyError) {
          const legacyMessage = this.sanitizeErrorMessage(legacyError.message);
          if (this.shouldRetryWithUserInstall(legacyMessage)) {
            return await runCommand(
              pythonCmd,
              buildInstallArgs({ user: true, legacy: true }),
              { timeout: TIMEOUTS.DOWNLOAD },
            );
          }
          throw new Error(this.formatWhisperInstallError(legacyMessage));
        }
      }

      throw new Error(this.formatWhisperInstallError(cleanMessage));
    }
  }

  async downloadWhisperModel(modelName, progressCallback = null) {
    try {
      const pythonCmd = await this.findPythonExecutable();
      const whisperScriptPath = this.getWhisperScriptPath();

      const args = [
        whisperScriptPath,
        "--mode",
        "download",
        "--model",
        modelName,
      ];

      return new Promise((resolve, reject) => {
        const downloadProcess = spawn(pythonCmd, args);
        this.currentDownloadProcess = downloadProcess; // Store for potential cancellation

        let stdout = "";
        let stderr = "";

        downloadProcess.stdout.on("data", (data) => {
          stdout += data.toString();
        });

        downloadProcess.stderr.on("data", (data) => {
          const output = data.toString();
          stderr += output;

          // Parse progress updates from stderr
          const lines = output.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("PROGRESS:")) {
              try {
                const progressData = JSON.parse(trimmed.substring(9));
                if (progressCallback) {
                  progressCallback({
                    type: "progress",
                    model: modelName,
                    ...progressData,
                  });
                }
              } catch (parseError) {
                // Ignore parsing errors for progress data
              }
            }
          }
        });

        downloadProcess.on("close", (code) => {
          this.currentDownloadProcess = null; // Clear process reference

          if (code === 0) {
            try {
              const result = JSON.parse(stdout);
              resolve(result);
            } catch (parseError) {
              console.error("Failed to parse download result:", parseError);
              reject(
                new Error(
                  `Failed to parse download result: ${parseError.message}`,
                ),
              );
            }
          } else {
            // Handle cancellation cases (SIGTERM, SIGKILL, or null exit codes)
            if (code === 143 || code === 137 || code === null) {
              reject(new Error("Download interrupted by user"));
            } else {
              console.error("Model download failed with code:", code);
              reject(new Error(`Model download failed (exit code ${code})`));
            }
          }
        });

        downloadProcess.on("error", (error) => {
          this.currentDownloadProcess = null;
          console.error("Model download process error:", error);
          reject(new Error(`Model download process error: ${error.message}`));
        });

        const timeout = setTimeout(() => {
          downloadProcess.kill("SIGTERM");
          setTimeout(() => {
            if (!downloadProcess.killed) {
              downloadProcess.kill("SIGKILL");
            }
          }, 5000);
          reject(new Error("Model download timed out (20 minutes)"));
        }, 1200000);

        downloadProcess.on("close", () => {
          clearTimeout(timeout);
        });
      });
    } catch (error) {
      console.error("Model download error:", error);
      throw error;
    }
  }

  async cancelDownload() {
    if (this.currentDownloadProcess) {
      try {
        this.currentDownloadProcess.kill("SIGTERM");
        setTimeout(() => {
          if (
            this.currentDownloadProcess &&
            !this.currentDownloadProcess.killed
          ) {
            this.currentDownloadProcess.kill("SIGKILL");
          }
        }, 3000);
        return { success: true, message: "Download cancelled" };
      } catch (error) {
        console.error("Error cancelling download:", error);
        return { success: false, error: error.message };
      }
    } else {
      return { success: false, error: "No active download to cancel" };
    }
  }

  async checkModelStatus(modelName) {
    try {
      const pythonCmd = await this.findPythonExecutable();
      const whisperScriptPath = this.getWhisperScriptPath();

      const args = [whisperScriptPath, "--mode", "check", "--model", modelName];

      return new Promise((resolve, reject) => {
        const checkProcess = spawn(pythonCmd, args);

        let stdout = "";
        let stderr = "";

        checkProcess.stdout.on("data", (data) => {
          stdout += data.toString();
        });

        checkProcess.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        checkProcess.on("close", (code) => {
          if (code === 0) {
            try {
              const result = JSON.parse(stdout);
              resolve(result);
            } catch (parseError) {
              console.error("Failed to parse model status:", parseError);
              reject(
                new Error(
                  `Failed to parse model status: ${parseError.message}`,
                ),
              );
            }
          } else {
            console.error("Model status check failed with code:", code);
            reject(
              new Error(`Model status check failed (code ${code}): ${stderr}`),
            );
          }
        });

        checkProcess.on("error", (error) => {
          reject(new Error(`Model status check error: ${error.message}`));
        });
      });
    } catch (error) {
      throw error;
    }
  }

  async listWhisperModels() {
    try {
      const pythonCmd = await this.findPythonExecutable();
      const whisperScriptPath = this.getWhisperScriptPath();

      const args = [whisperScriptPath, "--mode", "list"];

      return new Promise((resolve, reject) => {
        const listProcess = spawn(pythonCmd, args);

        let stdout = "";
        let stderr = "";

        listProcess.stdout.on("data", (data) => {
          stdout += data.toString();
        });

        listProcess.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        listProcess.on("close", (code) => {
          if (code === 0) {
            try {
              const result = JSON.parse(stdout);
              resolve(result);
            } catch (parseError) {
              console.error("Failed to parse model list:", parseError);
              reject(
                new Error(`Failed to parse model list: ${parseError.message}`),
              );
            }
          } else {
            console.error("Model list failed with code:", code);
            reject(new Error(`Model list failed (code ${code}): ${stderr}`));
          }
        });

        listProcess.on("error", (error) => {
          reject(new Error(`Model list error: ${error.message}`));
        });
      });
    } catch (error) {
      throw error;
    }
  }

  async deleteWhisperModel(modelName) {
    try {
      const pythonCmd = await this.findPythonExecutable();
      const whisperScriptPath = this.getWhisperScriptPath();

      const args = [
        whisperScriptPath,
        "--mode",
        "delete",
        "--model",
        modelName,
      ];

      return new Promise((resolve, reject) => {
        const deleteProcess = spawn(pythonCmd, args);

        let stdout = "";
        let stderr = "";

        deleteProcess.stdout.on("data", (data) => {
          stdout += data.toString();
        });

        deleteProcess.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        deleteProcess.on("close", (code) => {
          if (code === 0) {
            try {
              const result = JSON.parse(stdout);
              resolve(result);
            } catch (parseError) {
              console.error("Failed to parse delete result:", parseError);
              reject(
                new Error(
                  `Failed to parse delete result: ${parseError.message}`,
                ),
              );
            }
          } else {
            console.error("Model delete failed with code:", code);
            reject(new Error(`Model delete failed (code ${code}): ${stderr}`));
          }
        });

        deleteProcess.on("error", (error) => {
          reject(new Error(`Model delete error: ${error.message}`));
        });
      });
    } catch (error) {
      throw error;
    }
  }
}

module.exports = WhisperManager;
