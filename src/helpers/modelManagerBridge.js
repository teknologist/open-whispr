const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const { promises: fsPromises } = require("fs");
const https = require("https");
const { app } = require("electron");
const debugLogger = require("./debugLogger");

// Import the model registry data directly
let modelRegistryData;
try {
  modelRegistryData = require("../models/modelRegistryData.json");
  debugLogger.log("[ModelManager] Loaded registry data successfully");
} catch (error) {
  debugLogger.error("[ModelManager] Failed to load registry data:", error);
  // Fallback to inline data - minimal set for emergency use
  modelRegistryData = {
    providers: [
      {
        id: "qwen",
        name: "Qwen",
        baseUrl: "https://huggingface.co",
        models: [
          {
            id: "qwen2.5-0.5b-instruct-q5_k_m",
            name: "Qwen2.5 0.5B",
            size: "0.5GB",
            sizeBytes: 522186592,
            description: "Smallest model, fast but limited capabilities",
            fileName: "qwen2.5-0.5b-instruct-q5_k_m.gguf",
            quantization: "q5_k_m",
            contextLength: 32768,
          },
          {
            id: "qwen2.5-3b-instruct-q5_k_m",
            name: "Qwen2.5 3B",
            size: "2.3GB",
            sizeBytes: 2438740384,
            description: "Balanced model for general use",
            fileName: "qwen2.5-3b-instruct-q5_k_m.gguf",
            quantization: "q5_k_m",
            contextLength: 32768,
          },
        ],
      },
    ],
  };
}

class ModelError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ModelError";
    this.code = code;
    this.details = details;
  }
}

class ModelNotFoundError extends ModelError {
  constructor(modelId) {
    super(`Model ${modelId} not found`, "MODEL_NOT_FOUND", { modelId });
  }
}

class ModelManager {
  constructor() {
    this.modelsDir = this.getModelsDir();
    this.downloadProgress = new Map();
    this.activeDownloads = new Map();
    this.llamaCppPath = null;
    this.ensureModelsDirExists();
  }

  getModelsDir() {
    const homeDir = app.getPath("home");
    return path.join(homeDir, ".cache", "openwhispr", "models");
  }

  async ensureModelsDirExists() {
    try {
      await fsPromises.mkdir(this.modelsDir, { recursive: true });
    } catch (error) {
      debugLogger.error(
        "[ModelManager] Failed to create models directory:",
        error,
      );
    }
  }

  async getAllModels() {
    try {
      const models = [];

      debugLogger.log("[ModelManager] Getting all models from registry");

      // Get all models from registry
      for (const provider of modelRegistryData.providers) {
        for (const model of provider.models) {
          const modelPath = path.join(this.modelsDir, model.fileName);
          const isDownloaded = await this.checkFileExists(modelPath);

          models.push({
            ...model,
            providerId: provider.id,
            providerName: provider.name,
            isDownloaded,
            path: isDownloaded ? modelPath : null,
          });
        }
      }

      debugLogger.log("[ModelManager] Found models:", models.length);
      return models;
    } catch (error) {
      debugLogger.error("[ModelManager] Error getting all models:", error);
      throw error;
    }
  }

  async getModelsWithStatus() {
    return this.getAllModels();
  }

  async isModelDownloaded(modelId) {
    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) return false;

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);
    return this.checkFileExists(modelPath);
  }

  async checkFileExists(filePath) {
    try {
      await fsPromises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  findModelById(modelId) {
    for (const provider of modelRegistryData.providers) {
      const model = provider.models.find((m) => m.id === modelId);
      if (model) {
        return { model, provider };
      }
    }
    return null;
  }

  async downloadModel(modelId, onProgress) {
    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) {
      throw new ModelNotFoundError(modelId);
    }

    const { model, provider } = modelInfo;
    const modelPath = path.join(this.modelsDir, model.fileName);

    // Check if already downloaded
    if (await this.checkFileExists(modelPath)) {
      debugLogger.log(
        `[ModelManager] Model ${modelId} already downloaded at ${modelPath}`,
      );
      return modelPath;
    }

    // Check if already downloading
    if (this.activeDownloads.get(modelId)) {
      throw new ModelError(
        "Model is already being downloaded",
        "DOWNLOAD_IN_PROGRESS",
        { modelId },
      );
    }

    this.activeDownloads.set(modelId, true);
    debugLogger.log(`[ModelManager] Starting download for ${modelId}`);

    try {
      // Construct download URL based on provider
      const downloadUrl = this.getDownloadUrl(provider, model);
      debugLogger.log(`[ModelManager] Download URL: ${downloadUrl}`);

      await this.downloadFile(
        downloadUrl,
        modelPath,
        (progress, downloadedSize, totalSize) => {
          this.downloadProgress.set(modelId, {
            modelId,
            progress,
            downloadedSize,
            totalSize,
          });
          if (onProgress) {
            onProgress(progress, downloadedSize, totalSize);
          }
        },
      );

      // Validate file integrity if sizeBytes is available
      if (model.sizeBytes) {
        await this.validateDownloadedFile(modelPath, model.sizeBytes);
      }

      debugLogger.log(`[ModelManager] Download complete for ${modelId}`);
      return modelPath;
    } finally {
      this.activeDownloads.delete(modelId);
      this.downloadProgress.delete(modelId);
    }
  }

  getDownloadUrl(provider, model) {
    // Based on the provider type, construct the download URL
    // Using model.id for more robust URL construction instead of parsing model.name
    switch (provider.id) {
      case "qwen": {
        // Use bartowski repo for 7B models (they have single-file versions)
        if (model.useBartowski) {
          return `https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/${model.fileName}`;
        }
        // Extract size from model ID (e.g., "qwen2.5-0.5b-instruct-q5_k_m" -> "0.5B")
        const sizeMatch = model.id.match(/qwen2\.5-(\d+\.?\d*b)-/i);
        const size = sizeMatch
          ? sizeMatch[1].toUpperCase()
          : model.name.split(" ")[1];
        return `https://huggingface.co/Qwen/Qwen2.5-${size}-Instruct-GGUF/resolve/main/${model.fileName}`;
      }

      case "mistral":
        if (model.id.includes("v0.3")) {
          return `https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/${model.fileName}`;
        }
        return `https://huggingface.co/TheBloke/Mistral-7B-v0.1-GGUF/resolve/main/${model.fileName}`;

      case "llama":
        if (model.id.includes("3.2-1b")) {
          return `https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/${model.fileName}`;
        }
        if (model.id.includes("3.2-3b")) {
          return `https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/${model.fileName}`;
        }
        return `https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/${model.fileName}`;

      case "openai-oss":
        return `https://huggingface.co/bartowski/openai_gpt-oss-20b-GGUF/resolve/main/${model.fileName}`;

      default:
        throw new ModelError(
          `Unknown provider: ${provider.id}`,
          "UNKNOWN_PROVIDER",
          { providerId: provider.id },
        );
    }
  }

  async downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      let downloadedSize = 0;
      let totalSize = 0;

      // Helper to safely close file and cleanup
      const cleanupFile = async (callback) => {
        file.end(() => {
          fsPromises
            .unlink(destPath)
            .catch(() => {})
            .finally(callback);
        });
      };

      https
        .get(
          url,
          {
            headers: { "User-Agent": "OpenWhispr/1.0" },
            timeout: 30000,
          },
          (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
              // Handle redirect - properly close before cleanup
              cleanupFile(() => {
                this.downloadFile(
                  response.headers.location,
                  destPath,
                  onProgress,
                )
                  .then(resolve)
                  .catch(reject);
              });
              return;
            }

            if (response.statusCode !== 200) {
              cleanupFile(() => {
                reject(
                  new ModelError(
                    `Download failed with status ${response.statusCode}`,
                    "DOWNLOAD_FAILED",
                    { statusCode: response.statusCode },
                  ),
                );
              });
              return;
            }

            totalSize = parseInt(response.headers["content-length"], 10);

            response.on("data", (chunk) => {
              downloadedSize += chunk.length;
              file.write(chunk);

              if (onProgress && totalSize > 0) {
                const progress = (downloadedSize / totalSize) * 100;
                onProgress(progress, downloadedSize, totalSize);
              }
            });

            response.on("end", () => {
              file.end(() => {
                resolve(destPath);
              });
            });

            response.on("error", (error) => {
              cleanupFile(() => {
                reject(
                  new ModelError(
                    `Download error: ${error.message}`,
                    "DOWNLOAD_ERROR",
                    { error: error.message },
                  ),
                );
              });
            });
          },
        )
        .on("error", (error) => {
          cleanupFile(() => {
            reject(
              new ModelError(
                `Network error: ${error.message}`,
                "NETWORK_ERROR",
                {
                  error: error.message,
                },
              ),
            );
          });
        });
    });
  }

  async validateDownloadedFile(modelPath, expectedSizeBytes) {
    try {
      const stats = await fsPromises.stat(modelPath);
      // Allow 5% tolerance for size differences (HuggingFace file sizes can vary slightly)
      const tolerance = expectedSizeBytes * 0.05;
      if (Math.abs(stats.size - expectedSizeBytes) > tolerance) {
        debugLogger.error(
          `[ModelManager] File size mismatch. Expected ~${expectedSizeBytes}, got ${stats.size}`,
        );
        await fsPromises.unlink(modelPath);
        throw new ModelError(
          `Downloaded file size mismatch. Expected ~${expectedSizeBytes} bytes, got ${stats.size} bytes`,
          "SIZE_MISMATCH",
          { expected: expectedSizeBytes, actual: stats.size },
        );
      }
      debugLogger.log(
        `[ModelManager] File size validated: ${stats.size} bytes`,
      );
      return true;
    } catch (error) {
      if (error.code === "SIZE_MISMATCH") throw error;
      debugLogger.error("[ModelManager] Error validating file:", error);
      throw error;
    }
  }

  async deleteModel(modelId) {
    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) {
      throw new ModelNotFoundError(modelId);
    }

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);

    if (await this.checkFileExists(modelPath)) {
      await fsPromises.unlink(modelPath);
    }
  }

  async deleteAllModels() {
    try {
      if (fsPromises.rm) {
        await fsPromises.rm(this.modelsDir, { recursive: true, force: true });
      } else {
        const entries = await fsPromises
          .readdir(this.modelsDir, { withFileTypes: true })
          .catch(() => []);
        for (const entry of entries) {
          const fullPath = path.join(this.modelsDir, entry.name);
          if (entry.isDirectory()) {
            await fsPromises
              .rmdir(fullPath, { recursive: true })
              .catch(() => {});
          } else {
            await fsPromises.unlink(fullPath).catch(() => {});
          }
        }
      }
    } catch (error) {
      throw new ModelError(
        `Failed to delete models directory: ${error.message}`,
        "DELETE_ALL_ERROR",
        { error: error.message },
      );
    } finally {
      await this.ensureModelsDirExists();
    }
  }

  async ensureLlamaCpp() {
    // Simplify - isInstalled already checks system installation
    const llamaCppInstaller = require("./llamaCppInstaller").default;

    if (!(await llamaCppInstaller.isInstalled())) {
      throw new ModelError(
        "llama.cpp is not installed",
        "LLAMACPP_NOT_INSTALLED",
      );
    }

    this.llamaCppPath = await llamaCppInstaller.getBinaryPath();
    return true;
  }

  async runInference(modelId, prompt, options = {}) {
    console.log("[ModelManagerBridge] runInference START", {
      modelId,
      promptLength: prompt?.length,
    });
    await this.ensureLlamaCpp();
    console.log(
      "[ModelManagerBridge] ensureLlamaCpp done, path:",
      this.llamaCppPath,
    );

    const modelInfo = this.findModelById(modelId);
    if (!modelInfo) {
      console.log("[ModelManagerBridge] Model not found:", modelId);
      throw new ModelNotFoundError(modelId);
    }
    console.log("[ModelManagerBridge] Found model:", modelInfo.model.fileName);

    const modelPath = path.join(this.modelsDir, modelInfo.model.fileName);
    if (!(await this.checkFileExists(modelPath))) {
      console.log("[ModelManagerBridge] Model file not found:", modelPath);
      throw new ModelError(
        `Model ${modelId} is not downloaded`,
        "MODEL_NOT_DOWNLOADED",
        { modelId },
      );
    }
    console.log("[ModelManagerBridge] Model file exists:", modelPath);

    // Format the prompt based on the provider
    const formattedPrompt = this.formatPrompt(
      modelInfo.provider,
      prompt,
      options.systemPrompt || "",
    );
    console.log(
      "[ModelManagerBridge] Formatted prompt length:",
      formattedPrompt?.length,
    );

    // Run inference with llama.cpp
    const gpuLayers = options.gpuLayers ?? 99; // Default to full GPU offload

    return new Promise((resolve, reject) => {
      console.log("[ModelManagerBridge] About to spawn llama.cpp process");
      const args = [
        "-m",
        modelPath,
        "-p",
        formattedPrompt,
        "-n",
        String(options.maxTokens || 512),
        "--temp",
        String(options.temperature || 0.7),
        "--top-k",
        String(options.topK || 40),
        "--top-p",
        String(options.topP || 0.9),
        "--repeat-penalty",
        String(options.repeatPenalty || 1.1),
        "-c",
        String(options.contextSize || modelInfo.model.contextLength),
        "-t",
        String(options.threads || 4),
        "-ngl",
        String(gpuLayers),
        "--no-display-prompt",
        "--single-turn", // Exit after one generation (don't stay in conversation mode)
        "--simple-io", // Use basic IO for subprocess compatibility (output to stdout)
      ];

      debugLogger.log(
        `[ModelManager] Running inference with GPU layers: ${gpuLayers}`,
      );
      debugLogger.log(`[ModelManager] llama.cpp args:`, args.join(" "));

      console.log("[ModelManagerBridge] Spawning:", this.llamaCppPath);
      const inferenceProcess = spawn(this.llamaCppPath, args);
      console.log(
        "[ModelManagerBridge] Process spawned, pid:",
        inferenceProcess.pid,
      );
      let output = "";
      let error = "";

      inferenceProcess.stdout.on("data", (data) => {
        const chunk = data.toString();
        console.log(
          "[ModelManagerBridge] stdout chunk:",
          chunk.substring(0, 100),
        );
        output += chunk;
      });

      inferenceProcess.stderr.on("data", (data) => {
        const chunk = data.toString();
        error += chunk;
        // Log stderr which contains GPU/CUDA info from llama.cpp
        console.log(
          "[ModelManagerBridge] stderr:",
          chunk.trim().substring(0, 200),
        );
        debugLogger.log(`[ModelManager] llama.cpp: ${chunk.trim()}`);
      });

      inferenceProcess.on("close", (code) => {
        console.log("[ModelManagerBridge] Process closed with code:", code);
        console.log("[ModelManagerBridge] Raw output length:", output.length);
        if (code !== 0) {
          console.log(
            "[ModelManagerBridge] Inference failed, error:",
            error.substring(0, 500),
          );
          reject(
            new ModelError(
              `Inference failed with code ${code}: ${error}`,
              "INFERENCE_FAILED",
              { code, error },
            ),
          );
        } else {
          // Clean the output: remove llama.cpp banner and timing info
          const cleanedOutput = this.cleanLlamaOutput(output);
          console.log(
            "[ModelManagerBridge] Cleaned output:",
            cleanedOutput.substring(0, 200),
          );
          resolve(cleanedOutput);
        }
      });

      inferenceProcess.on("error", (err) => {
        console.log("[ModelManagerBridge] Process error:", err.message);
        reject(
          new ModelError(
            `Failed to start inference: ${err.message}`,
            "INFERENCE_START_FAILED",
            { error: err.message },
          ),
        );
      });
    });
  }

  formatPrompt(provider, text, systemPrompt) {
    // Format prompts according to each model's expected format
    // See: https://huggingface.co/docs/transformers/chat_templating
    switch (provider.id) {
      case "qwen":
      case "openai-oss":
        // ChatML format (used by Qwen and OpenAI models)
        // https://github.com/openai/openai-python/blob/main/chatml.md
        return `<|im_start|>system\n${systemPrompt}<|im_end|>\n<|im_start|>user\n${text}<|im_end|>\n<|im_start|>assistant\n`;

      case "mistral":
        // Mistral instruction format
        // https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.1#instruction-format
        return `[INST] ${systemPrompt}\n\n${text} [/INST]`;

      case "llama":
        // Llama 3 instruction format
        // https://llama.meta.com/docs/model-cards-and-prompt-formats/meta-llama-3/
        return `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n${systemPrompt}<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n${text}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`;

      default:
        // Throw error for unknown providers to catch configuration issues early
        throw new ModelError(
          `Unknown provider for prompt formatting: ${provider.id}`,
          "UNKNOWN_PROVIDER",
          { providerId: provider.id },
        );
    }
  }

  /**
   * Clean llama.cpp output by removing banner, timing info, prompt tokens, and other noise
   * @param {string} output - Raw output from llama.cpp
   * @returns {string} - Cleaned output containing only the generated text
   */
  cleanLlamaOutput(output) {
    if (!output) return "";

    let cleaned = output;

    // Remove the llama.cpp ASCII art banner (contains ██ characters)
    // The banner ends after the last line with box-drawing characters
    const bannerEndPatterns = [
      /Loading model\.\.\.[\s\S]*?▀▀    ▀▀\s*/,
      /▄▄[\s\S]*?▀▀    ▀▀\s*/,
    ];
    for (const pattern of bannerEndPatterns) {
      cleaned = cleaned.replace(pattern, "");
    }

    // Remove the entire prompt section (everything up to and including the assistant header)
    // This handles Llama format: <|begin_of_text|>...<|start_header_id|>assistant<|end_header_id|>
    cleaned = cleaned.replace(
      /<\|begin_of_text\|>[\s\S]*?<\|start_header_id\|>assistant<\|end_header_id\|>\s*/g,
      "",
    );

    // Also handle ChatML format: <|im_start|>assistant
    cleaned = cleaned.replace(
      /<\|im_start\|>system[\s\S]*?<\|im_start\|>assistant\s*/g,
      "",
    );

    // Handle Mistral format: [INST]...[/INST]
    cleaned = cleaned.replace(/\[INST\][\s\S]*?\[\/INST\]\s*/g, "");

    // Remove any remaining special tokens
    cleaned = cleaned.replace(/<\|[^|]+\|>/g, "");

    // Remove timing info: [ Prompt: X t/s | Generation: Y t/s ]
    cleaned = cleaned.replace(
      /\[\s*Prompt:\s*[\d.]+\s*t\/s\s*\|\s*Generation:\s*[\d.]+\s*t\/s\s*\]/g,
      "",
    );

    // Remove "Exiting..." message
    cleaned = cleaned.replace(/Exiting\.\.\.\s*/g, "");

    // Remove any "build" and "model" info lines
    cleaned = cleaned.replace(/build\s*:\s*\S+\s*/g, "");
    cleaned = cleaned.replace(/model\s*:\s*\S+\s*/g, "");
    cleaned = cleaned.replace(/modalities\s*:\s*\S+\s*/g, "");

    // Remove "available commands" section
    cleaned = cleaned.replace(
      /available commands:[\s\S]*?\/read[^\n]*\n*/g,
      "",
    );

    // Remove any remaining > prompt markers
    cleaned = cleaned.replace(/^>\s*/gm, "");

    // Trim whitespace
    cleaned = cleaned.trim();

    return cleaned;
  }
}

module.exports = {
  default: new ModelManager(),
  ModelError,
  ModelNotFoundError,
};
