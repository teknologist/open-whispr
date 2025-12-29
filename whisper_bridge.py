#!/usr/bin/env python3
"""
Whisper Bridge Script for OpenWhispr
Handles local speech-to-text processing using OpenAI's Whisper model
Supports both standard Whisper and Distil-Whisper models via faster-whisper
"""

import sys
import json
import os
import argparse
from pathlib import Path
import threading
import time
import gc

# Auto-detect and preload cuDNN libraries from pip packages
def preload_cudnn_libraries():
    """Preload cuDNN libraries from pip packages before CTranslate2 loads"""
    import ctypes
    try:
        import site
        site_packages = site.getsitepackages()
        if hasattr(site, 'getusersitepackages'):
            user_site = site.getusersitepackages()
            if user_site:
                site_packages.append(user_site)

        # Libraries to preload in order (dependencies first)
        lib_names = [
            "libcudnn.so.9",
            "libcudnn_ops.so.9",
            "libcudnn_cnn.so.9",
            "libcudnn_adv.so.9",
            "libcudnn_graph.so.9",
            "libcudnn_engines_precompiled.so.9",
            "libcudnn_engines_runtime_compiled.so.9",
            "libcudnn_heuristic.so.9",
        ]

        # Track loaded paths to prevent double-loading from different locations
        loaded_paths = set()
        loaded_names = []
        for sp in site_packages:
            if not sp:
                continue
            cudnn_lib_dir = os.path.join(sp, "nvidia", "cudnn", "lib")
            if os.path.isdir(cudnn_lib_dir):
                for lib_name in lib_names:
                    lib_path = os.path.join(cudnn_lib_dir, lib_name)
                    # Resolve to real path to handle symlinks
                    real_path = os.path.realpath(lib_path)
                    if os.path.exists(lib_path) and real_path not in loaded_paths:
                        try:
                            # Use RTLD_LOCAL instead of RTLD_GLOBAL to avoid symbol conflicts
                            ctypes.CDLL(lib_path, mode=ctypes.RTLD_LOCAL)
                            loaded_paths.add(real_path)
                            loaded_names.append(lib_name)
                        except OSError as e:
                            print(f"[whisper_bridge] Warning: Could not load {lib_name}: {e}", file=sys.stderr)

        if loaded_names:
            print(f"[whisper_bridge] Preloaded cuDNN libraries: {loaded_names}", file=sys.stderr)
            return True
        return False
    except (ImportError, AttributeError) as e:
        # Handle missing site module or attributes gracefully
        print(f"[whisper_bridge] Warning: Could not preload cuDNN (site issue): {e}", file=sys.stderr)
        return False
    except OSError as e:
        print(f"[whisper_bridge] Warning: Could not preload cuDNN (OS error): {e}", file=sys.stderr)
        return False

_cudnn_preloaded = preload_cudnn_libraries()

# Model definitions - standard Whisper and Distil-Whisper
# For standard models (tiny, base, small, medium, large-v3, turbo),
# faster-whisper handles the download internally - just pass the size name
# For distil models, we use explicit HuggingFace repo IDs
WHISPER_MODELS = {
    # Standard Whisper models - use built-in faster-whisper names
    # All standard models support 99+ languages with auto-detection
    "tiny": {
        "hf_id": "tiny",  # faster-whisper built-in
        "size_mb": 75,
        "description": "Fastest, multilingual, lower quality",
        "family": "whisper"
    },
    "base": {
        "hf_id": "base",  # faster-whisper built-in
        "size_mb": 145,
        "description": "Multilingual, good balance",
        "family": "whisper"
    },
    "small": {
        "hf_id": "small",  # faster-whisper built-in
        "size_mb": 488,
        "description": "Multilingual, better quality",
        "family": "whisper"
    },
    "medium": {
        "hf_id": "medium",  # faster-whisper built-in
        "size_mb": 1530,
        "description": "Multilingual, high quality",
        "family": "whisper"
    },
    "large-v3": {
        "hf_id": "large-v3",  # faster-whisper built-in
        "size_mb": 3094,
        "description": "Multilingual, best quality",
        "family": "whisper"
    },
    "turbo": {
        "hf_id": "turbo",  # faster-whisper built-in (large-v3-turbo)
        "size_mb": 1620,
        "description": "Multilingual, fast + good quality",
        "family": "whisper"
    },
    # Distil-Whisper models - explicit HuggingFace repos
    # NOTE: All distil models output ENGLISH ONLY (they detect language but transcribe to English)
    "distil-small.en": {
        "hf_id": "Systran/faster-distil-whisper-small.en",
        "size_mb": 166,
        "description": "6x faster, English input/output only",
        "family": "distil-whisper"
    },
    "distil-medium.en": {
        "hf_id": "Systran/faster-distil-whisper-medium.en",
        "size_mb": 394,
        "description": "Fast, English input/output only",
        "family": "distil-whisper"
    },
    "distil-large-v2": {
        "hf_id": "Systran/faster-distil-whisper-large-v2",
        "size_mb": 756,
        "description": "6x faster, multilingual→English output",
        "family": "distil-whisper"
    },
    "distil-large-v3": {
        "hf_id": "Systran/faster-distil-whisper-large-v3",
        "size_mb": 756,
        "description": "6x faster, multilingual→English output",
        "family": "distil-whisper"
    },
}


def get_ffmpeg_path():
    """Get path to bundled FFmpeg executable with proper production support"""
    # Check environment variables first
    env_paths = [
        ("FFMPEG_PATH", os.environ.get("FFMPEG_PATH")),
        ("FFMPEG_EXECUTABLE", os.environ.get("FFMPEG_EXECUTABLE")),
        ("FFMPEG_BINARY", os.environ.get("FFMPEG_BINARY"))
    ]

    for env_name, env_path in env_paths:
        if env_path and os.path.exists(env_path) and os.access(env_path, os.X_OK):
            return env_path

    # Determine base path
    if getattr(sys, 'frozen', False):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.dirname(os.path.abspath(__file__))

    # Try multiple possible paths for production Electron app
    possible_paths = []

    if sys.platform == "darwin":  # macOS
        possible_paths = [
            # Unpacked ASAR locations
            os.path.join(base_path, "..", "..", "..", "app.asar.unpacked", "node_modules", "ffmpeg-static", "ffmpeg"),
            os.path.join(base_path, "..", "app.asar.unpacked", "node_modules", "ffmpeg-static", "ffmpeg"),
            # Development path
            os.path.join(base_path, "node_modules", "ffmpeg-static", "ffmpeg"),
            # Alternative development path
            os.path.join(base_path, "..", "node_modules", "ffmpeg-static", "ffmpeg"),
        ]
    elif sys.platform == "win32":  # Windows
        possible_paths = [
            os.path.join(base_path, "..", "..", "..", "app.asar.unpacked", "node_modules", "ffmpeg-static", "ffmpeg.exe"),
            os.path.join(base_path, "..", "app.asar.unpacked", "node_modules", "ffmpeg-static", "ffmpeg.exe"),
            os.path.join(base_path, "node_modules", "ffmpeg-static", "ffmpeg.exe"),
            os.path.join(base_path, "..", "node_modules", "ffmpeg-static", "ffmpeg.exe"),
        ]
    else:  # Linux
        possible_paths = [
            os.path.join(base_path, "..", "..", "..", "app.asar.unpacked", "node_modules", "ffmpeg-static", "ffmpeg"),
            os.path.join(base_path, "..", "app.asar.unpacked", "node_modules", "ffmpeg-static", "ffmpeg"),
            os.path.join(base_path, "node_modules", "ffmpeg-static", "ffmpeg"),
            os.path.join(base_path, "..", "node_modules", "ffmpeg-static", "ffmpeg"),
        ]

    # Try each possible path
    for ffmpeg_path in possible_paths:
        abs_path = os.path.abspath(ffmpeg_path)
        if os.path.exists(abs_path) and os.access(abs_path, os.X_OK):
            return abs_path

    # Try system FFmpeg as last resort
    if sys.platform == "darwin":
        common_ffmpeg_paths = [
            "/opt/homebrew/bin/ffmpeg",  # Homebrew on Apple Silicon
            "/usr/local/bin/ffmpeg",      # Homebrew on Intel or manual installs
            "/usr/bin/ffmpeg",            # System location
            "ffmpeg"                      # In PATH
        ]
    else:
        common_ffmpeg_paths = ["ffmpeg"]

    for ffmpeg_cmd in common_ffmpeg_paths:
        try:
            import subprocess
            result = subprocess.run([ffmpeg_cmd, "-version"], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                return ffmpeg_cmd
        except Exception:
            continue

    return None


# Set FFmpeg path
ffmpeg_path = get_ffmpeg_path()
if ffmpeg_path:
    os.environ["FFMPEG_BINARY"] = ffmpeg_path

    # CRITICAL: Add ffmpeg directory to PATH so faster-whisper can find it
    ffmpeg_dir = os.path.dirname(os.path.abspath(ffmpeg_path))
    current_path = os.environ.get("PATH", "")
    if ffmpeg_dir not in current_path:
        os.environ["PATH"] = f"{ffmpeg_dir}:{current_path}"

    # For faster-whisper library, we need to ensure 'ffmpeg' command works
    # Security: Only create symlink if ffmpeg_path is within expected directories
    if sys.platform != "win32" and os.path.isfile(ffmpeg_path) and os.path.basename(ffmpeg_path) != "ffmpeg":
        # Validate ffmpeg_path is in a safe location (node_modules, /usr, /opt, or homebrew)
        abs_ffmpeg_path = os.path.abspath(os.path.realpath(ffmpeg_path))
        safe_prefixes = [
            "/usr/",
            "/opt/",
            "/bin/",
            os.path.expanduser("~/.local/"),
        ]
        # Also allow paths within the app's directory structure
        script_dir = os.path.dirname(os.path.abspath(__file__))
        safe_prefixes.append(os.path.dirname(script_dir))  # Parent of script dir

        is_safe_path = any(abs_ffmpeg_path.startswith(prefix) for prefix in safe_prefixes) or \
                       "node_modules" in abs_ffmpeg_path or \
                       "app.asar.unpacked" in abs_ffmpeg_path

        if is_safe_path:
            symlink_path = os.path.join(ffmpeg_dir, "ffmpeg")
            # Atomic symlink creation - avoids TOCTOU race by not checking exists first
            try:
                os.symlink(ffmpeg_path, symlink_path)
            except FileExistsError:
                pass  # Symlink already exists, that's fine
            except (OSError, PermissionError):
                pass  # Symlink creation failed, ffmpeg may still work via PATH


# Global model cache to avoid reloading
_model_cache = {}
_device = None


def check_cudnn_available():
    """Check if cuDNN is available for GPU inference"""
    # Use the result from preloading attempt
    return _cudnn_preloaded


def get_device():
    """Detect and return the best available device (CUDA > CPU)"""
    global _device
    if _device is not None:
        return _device

    try:
        import torch
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            if check_cudnn_available():
                _device = "cuda"
                print(f"[whisper_bridge] Using GPU: {gpu_name}", file=sys.stderr)
            else:
                _device = "cpu"
                print(f"[whisper_bridge] GPU detected ({gpu_name}) but cuDNN not found, using CPU", file=sys.stderr)
                print("[whisper_bridge] Install cuDNN for GPU acceleration: pip install nvidia-cudnn-cu12", file=sys.stderr)
        else:
            _device = "cpu"
            print("[whisper_bridge] CUDA not available, using CPU", file=sys.stderr)
    except ImportError:
        _device = "cpu"
        print("[whisper_bridge] PyTorch not found, using CPU", file=sys.stderr)

    return _device


def get_compute_type():
    """Get the appropriate compute type based on device"""
    device = get_device()
    if device == "cuda":
        return "float16"
    return "int8"  # Use int8 for CPU for better performance


def get_cache_dir():
    """Get the cache directory for models"""
    return os.path.expanduser("~/.cache/huggingface/hub")


def get_model_cache_path(model_name):
    """Get the expected cache path for a model"""
    if model_name not in WHISPER_MODELS:
        return None

    model_info = WHISPER_MODELS[model_name]
    hf_id = model_info["hf_id"]

    # Built-in models (tiny, base, etc.) vs explicit HuggingFace repos
    if "/" in hf_id:
        # Explicit HuggingFace repo: models--{org}--{repo}
        cache_name = f"models--{hf_id.replace('/', '--')}"
    else:
        # Built-in faster-whisper model names map to Systran repos
        # e.g., "base" -> "Systran/faster-whisper-base"
        if hf_id == "turbo":
            cache_name = "models--Systran--faster-whisper-large-v3-turbo"
        elif hf_id == "large-v3":
            cache_name = "models--Systran--faster-whisper-large-v3"
        else:
            cache_name = f"models--Systran--faster-whisper-{hf_id}"

    cache_dir = get_cache_dir()
    return os.path.join(cache_dir, cache_name)


def is_model_downloaded(model_name):
    """Check if a model is already downloaded"""
    cache_path = get_model_cache_path(model_name)
    if cache_path and os.path.exists(cache_path):
        # Check for snapshots directory which indicates complete download
        snapshots_dir = os.path.join(cache_path, "snapshots")
        if os.path.exists(snapshots_dir) and os.listdir(snapshots_dir):
            return True
    return False


def get_model_size_on_disk(model_name):
    """Get the actual size of a downloaded model on disk"""
    cache_path = get_model_cache_path(model_name)
    if not cache_path or not os.path.exists(cache_path):
        return 0

    total_size = 0
    for dirpath, _, filenames in os.walk(cache_path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            if os.path.isfile(fp):
                total_size += os.path.getsize(fp)

    return total_size


def load_model(model_name="base"):
    """Load Whisper/Distil-Whisper model with caching for performance"""
    global _model_cache

    from faster_whisper import WhisperModel

    # Return cached model if available
    if model_name in _model_cache:
        return _model_cache[model_name]

    try:
        device = get_device()
        compute_type = get_compute_type()

        # Get HuggingFace model ID
        if model_name in WHISPER_MODELS:
            hf_id = WHISPER_MODELS[model_name]["hf_id"]
        else:
            # Fallback: try using the model name directly (for custom models)
            hf_id = model_name

        print(f"[whisper_bridge] Loading model '{model_name}' ({hf_id}) on {device} with {compute_type}", file=sys.stderr)

        model = WhisperModel(
            hf_id,
            device=device,
            compute_type=compute_type,
            download_root=None  # Uses default HuggingFace cache
        )

        # Limit cache size
        if len(_model_cache) >= 2:
            oldest_key = next(iter(_model_cache))
            del _model_cache[oldest_key]
            gc.collect()

        _model_cache[model_name] = model
        return model

    except (RuntimeError, ValueError, FileNotFoundError, OSError) as e:
        print(f"[whisper_bridge] Error loading model: {e}", file=sys.stderr)
        return None
    except ImportError as e:
        print(f"[whisper_bridge] Missing dependency for model: {e}", file=sys.stderr)
        return None


def monitor_download_progress(model_name, expected_size, stop_event):
    """Monitor download progress by watching cache directory size"""
    cache_path = get_model_cache_path(model_name)
    if not cache_path:
        return

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)

    last_size = 0
    last_update_time = time.time()
    start_time = time.time()
    speed_samples = []
    last_progress_update = 0

    # Maximum monitoring time (30 minutes) to prevent infinite loops
    MAX_MONITOR_TIME = 30 * 60

    while not stop_event.is_set():
        # Safety timeout to prevent infinite monitoring
        if time.time() - start_time > MAX_MONITOR_TIME:
            print(f"[whisper_bridge] Download monitoring timed out after {MAX_MONITOR_TIME}s", file=sys.stderr)
            break
        try:
            current_size = 0
            if os.path.exists(cache_path):
                for dirpath, _, filenames in os.walk(cache_path):
                    for f in filenames:
                        fp = os.path.join(dirpath, f)
                        if os.path.isfile(fp):
                            current_size += os.path.getsize(fp)

            current_time = time.time()
            time_diff = current_time - last_update_time

            speed_mbps = 0
            if last_size > 0 and time_diff > 0 and current_size > last_size:
                bytes_per_second = (current_size - last_size) / time_diff
                speed_mbps = (bytes_per_second * 8) / (1024 * 1024)

                speed_samples.append(speed_mbps)
                if len(speed_samples) > 10:
                    speed_samples.pop(0)
                speed_mbps = sum(speed_samples) / len(speed_samples)

            expected_bytes = expected_size * 1024 * 1024  # Convert MB to bytes
            percentage = min((current_size / expected_bytes * 100) if expected_bytes > 0 else 0, 100)

            if (current_time - last_progress_update > 0.5 or
                abs(percentage - last_progress_update) > 1.0):

                progress_data = {
                    "type": "progress",
                    "model": model_name,
                    "downloaded_bytes": current_size,
                    "total_bytes": expected_bytes,
                    "percentage": round(percentage, 1),
                    "speed_mbps": round(speed_mbps, 2) if speed_mbps > 0 else 0
                }

                print(f"PROGRESS:{json.dumps(progress_data)}", file=sys.stderr)
                last_progress_update = percentage

            if percentage >= 95:
                break

            if current_size == last_size and current_time - last_update_time > 10:
                if percentage > 90:
                    break

            last_size = current_size
            last_update_time = current_time

        except Exception:
            pass

        time.sleep(0.5)


def download_model(model_name="base"):
    """Download Whisper/Distil-Whisper model with real-time progress monitoring"""
    stop_event = threading.Event()
    progress_thread = None

    try:
        # Check if model is already downloaded
        if is_model_downloaded(model_name):
            file_size = get_model_size_on_disk(model_name)
            return {
                "model": model_name,
                "downloaded": True,
                "path": get_model_cache_path(model_name),
                "size_bytes": file_size,
                "size_mb": round(file_size / (1024 * 1024), 1),
                "success": True
            }

        if model_name not in WHISPER_MODELS:
            return {
                "model": model_name,
                "downloaded": False,
                "error": f"Unknown model: {model_name}",
                "success": False
            }

        # Get expected file size
        expected_size = WHISPER_MODELS[model_name]["size_mb"]

        # Start progress monitoring in background thread
        progress_thread = threading.Thread(
            target=monitor_download_progress,
            args=(model_name, expected_size, stop_event),
            daemon=True
        )
        progress_thread.start()

        # Start the actual download by loading the model
        model = load_model(model_name)

        # Stop progress monitoring
        stop_event.set()

        # Wait for progress thread to finish (give it 5 seconds to clean up)
        if progress_thread and progress_thread.is_alive():
            progress_thread.join(timeout=5)
            if progress_thread.is_alive():
                print("[whisper_bridge] Warning: Progress monitor thread did not exit cleanly", file=sys.stderr)

        if model is None:
            return {
                "model": model_name,
                "downloaded": False,
                "error": "Failed to download model",
                "success": False
            }

        # Get final file info
        final_size = get_model_size_on_disk(model_name)
        expected_bytes = expected_size * 1024 * 1024

        # Send completion signal
        completion_data = {
            "type": "complete",
            "model": model_name,
            "downloaded_bytes": final_size,
            "total_bytes": expected_bytes,
            "percentage": 100
        }
        print(f"PROGRESS:{json.dumps(completion_data)}", file=sys.stderr)

        return {
            "model": model_name,
            "downloaded": True,
            "path": get_model_cache_path(model_name),
            "size_bytes": final_size,
            "size_mb": round(final_size / (1024 * 1024), 1),
            "success": True
        }

    except KeyboardInterrupt:
        stop_event.set()
        return {
            "model": model_name,
            "downloaded": False,
            "error": "Download interrupted by user",
            "success": False
        }
    except Exception as e:
        stop_event.set()
        return {
            "model": model_name,
            "downloaded": False,
            "error": str(e),
            "success": False
        }


def check_model_status(model_name="base"):
    """Check if a model is already downloaded"""
    try:
        if model_name not in WHISPER_MODELS:
            return {
                "model": model_name,
                "error": f"Unknown model: {model_name}",
                "success": False
            }

        if is_model_downloaded(model_name):
            file_size = get_model_size_on_disk(model_name)
            return {
                "model": model_name,
                "downloaded": True,
                "path": get_model_cache_path(model_name),
                "size_bytes": file_size,
                "size_mb": round(file_size / (1024 * 1024), 1),
                "success": True
            }
        else:
            return {
                "model": model_name,
                "downloaded": False,
                "success": True
            }
    except Exception as e:
        return {
            "model": model_name,
            "error": str(e),
            "success": False
        }


def list_models():
    """List all available models and their download status"""
    model_info = []

    for model_name, info in WHISPER_MODELS.items():
        status = check_model_status(model_name)
        status["family"] = info["family"]
        status["description"] = info["description"]
        status["expected_size_mb"] = info["size_mb"]
        model_info.append(status)

    return {
        "models": model_info,
        "cache_dir": get_cache_dir(),
        "success": True
    }


def delete_model(model_name="base"):
    """Delete a downloaded model"""
    try:
        cache_path = get_model_cache_path(model_name)

        if cache_path and os.path.exists(cache_path):
            import shutil
            file_size = get_model_size_on_disk(model_name)
            shutil.rmtree(cache_path)

            # Also remove from model cache
            if model_name in _model_cache:
                del _model_cache[model_name]
                gc.collect()

            return {
                "model": model_name,
                "deleted": True,
                "freed_bytes": file_size,
                "freed_mb": round(file_size / (1024 * 1024), 1),
                "success": True
            }
        else:
            return {
                "model": model_name,
                "deleted": False,
                "error": "Model not found",
                "success": False
            }
    except Exception as e:
        return {
            "model": model_name,
            "deleted": False,
            "error": str(e),
            "success": False
        }


def transcribe_audio(audio_path, model_name="base", language=None, task="transcribe"):
    """Transcribe audio file using Whisper/Distil-Whisper with optimizations

    Args:
        audio_path: Path to audio file
        model_name: Whisper model name
        language: Language code (e.g., "en", "fr", "es") or None for auto-detect
        task: "transcribe" to keep original language, "translate" to convert to English
    """

    if not os.path.exists(audio_path):
        return {"error": f"Audio file not found: {audio_path}", "success": False}

    try:
        # Load model (uses cache for performance)
        model = load_model(model_name)
        if model is None:
            return {"error": "Failed to load model", "success": False}

        # Transcribe with faster-whisper
        options = {
            "beam_size": 5,
            "vad_filter": True,  # Voice activity detection for better results
            "task": task,  # "transcribe" or "translate"
        }

        if language:
            options["language"] = language

        print(f"[whisper_bridge] Transcribing with model={model_name}, task={task}, language={language}", file=sys.stderr)
        segments, info = model.transcribe(audio_path, **options)

        # Collect all text from segments
        text_parts = []
        for segment in segments:
            text_parts.append(segment.text)

        text = " ".join(text_parts).strip()
        detected_language = info.language if hasattr(info, 'language') else "unknown"
        print(f"[whisper_bridge] Result: detected_language={detected_language}, text={text[:50]}...", file=sys.stderr)

        return {
            "text": text,
            "language": detected_language,
            "success": True
        }

    except Exception as e:
        return {
            "error": str(e),
            "success": False
        }


def check_ffmpeg():
    """Check if FFmpeg is available and working"""
    try:
        import subprocess
        test_path = ffmpeg_path or "ffmpeg"

        result = subprocess.run([test_path, "-version"],
                              capture_output=True, text=True, timeout=10)

        if result.returncode == 0:
            version_line = result.stdout.split('\n')[0] if result.stdout else "Unknown"
            return {
                "available": True,
                "path": test_path,
                "version": version_line,
                "success": True
            }
        else:
            return {
                "available": False,
                "error": f"FFmpeg returned code {result.returncode}: {result.stderr}",
                "success": False
            }
    except subprocess.TimeoutExpired:
        return {
            "available": False,
            "error": "FFmpeg check timed out",
            "success": False
        }
    except FileNotFoundError:
        return {
            "available": False,
            "error": "FFmpeg not found in PATH",
            "success": False
        }
    except Exception as e:
        return {
            "available": False,
            "error": str(e),
            "success": False
        }


def run_server(model_name="base"):
    """Run as a persistent server that keeps the model loaded in GPU memory.

    Communicates via JSON over stdin/stdout:
    - Input: {"command": "transcribe", "audio_path": "/path/to/audio", "language": "auto"}
    - Input: {"command": "ping"} - health check
    - Input: {"command": "shutdown"} - graceful shutdown
    - Output: {"success": true, "text": "transcribed text", ...}
    """
    print(f"[whisper_bridge] Starting server mode with model '{model_name}'", file=sys.stderr)

    # Preload model into GPU memory
    model = load_model(model_name)
    if model is None:
        error_result = {"error": "Failed to load model", "success": False}
        print(json.dumps(error_result), flush=True)
        sys.exit(1)

    print(f"[whisper_bridge] Model '{model_name}' loaded and ready", file=sys.stderr)
    print(json.dumps({"type": "ready", "model": model_name, "success": True}), flush=True)

    # Server loop - read commands from stdin
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                # EOF - stdin closed
                print("[whisper_bridge] Server stdin closed, shutting down", file=sys.stderr)
                break

            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
            except json.JSONDecodeError as e:
                error_result = {"error": f"Invalid JSON: {e}", "success": False}
                print(json.dumps(error_result), flush=True)
                continue

            command = request.get("command", "transcribe")

            if command == "ping":
                # Health check
                print(json.dumps({"type": "pong", "success": True}), flush=True)

            elif command == "shutdown":
                print("[whisper_bridge] Received shutdown command", file=sys.stderr)
                print(json.dumps({"type": "shutdown", "success": True}), flush=True)
                break

            elif command == "transcribe":
                audio_path = request.get("audio_path")
                language = request.get("language")
                task = request.get("task", "transcribe")  # "transcribe" or "translate"
                print(f"[whisper_bridge] Server received: task={task}, language={language}", file=sys.stderr)

                if not audio_path:
                    error_result = {"error": "Missing audio_path", "success": False}
                    print(json.dumps(error_result), flush=True)
                    continue

                if not os.path.exists(audio_path):
                    error_result = {"error": f"Audio file not found: {audio_path}", "success": False}
                    print(json.dumps(error_result), flush=True)
                    continue

                # Transcribe using the preloaded model
                result = transcribe_audio(audio_path, model_name, language, task)
                print(json.dumps(result), flush=True)

            elif command == "reload":
                # Reload model (e.g., if user changed model selection)
                new_model = request.get("model", model_name)
                if new_model == model_name:
                    print(json.dumps({"type": "reloaded", "model": model_name, "success": True}), flush=True)
                    continue

                print(f"[whisper_bridge] Unloading model '{model_name}' to free GPU memory", file=sys.stderr)
                # Explicitly unload previous model to free GPU memory
                if model_name in _model_cache:
                    del _model_cache[model_name]
                del model
                gc.collect()
                # Force CUDA memory cleanup if available
                try:
                    import torch
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                        print("[whisper_bridge] GPU memory cleared", file=sys.stderr)
                except ImportError:
                    pass

                print(f"[whisper_bridge] Loading new model '{new_model}'", file=sys.stderr)
                model = load_model(new_model)
                if model is None:
                    error_result = {"error": f"Failed to load model '{new_model}'", "success": False}
                    print(json.dumps(error_result), flush=True)
                else:
                    model_name = new_model
                    print(json.dumps({"type": "reloaded", "model": model_name, "success": True}), flush=True)

            else:
                error_result = {"error": f"Unknown command: {command}", "success": False}
                print(json.dumps(error_result), flush=True)

        except KeyboardInterrupt:
            print("[whisper_bridge] Server interrupted", file=sys.stderr)
            break
        except Exception as e:
            error_result = {"error": f"Server error: {e}", "success": False}
            print(json.dumps(error_result), flush=True)

    print("[whisper_bridge] Server shutdown complete", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Whisper Bridge for OpenWhispr")
    parser.add_argument("--mode", default="transcribe",
                       choices=["transcribe", "download", "check", "list", "delete", "check-ffmpeg", "server"],
                       help="Operation mode (default: transcribe)")
    parser.add_argument("audio_file", nargs="?", help="Path to audio file to transcribe")
    parser.add_argument("--model", default="base",
                       help="Whisper model to use (default: base)")
    parser.add_argument("--language", help="Language code (optional)")
    parser.add_argument("--task", default="transcribe",
                       choices=["transcribe", "translate"],
                       help="Task: 'transcribe' keeps original language, 'translate' converts to English (default: transcribe)")
    parser.add_argument("--output-format", default="json",
                       choices=["json", "text"],
                       help="Output format (default: json)")

    args = parser.parse_args()

    # Handle different modes
    if args.mode == "server":
        run_server(args.model)
        return
    elif args.mode == "download":
        result = download_model(args.model)
        print(json.dumps(result))
        return
    elif args.mode == "check":
        result = check_model_status(args.model)
        print(json.dumps(result))
        return
    elif args.mode == "list":
        result = list_models()
        print(json.dumps(result))
        return
    elif args.mode == "delete":
        result = delete_model(args.model)
        print(json.dumps(result))
        return
    elif args.mode == "check-ffmpeg":
        result = check_ffmpeg()
        print(json.dumps(result))
        return
    elif args.mode == "transcribe":
        # Check if audio file exists
        if not args.audio_file:
            error_result = {"error": "Audio file required for transcription mode", "success": False}
            print(json.dumps(error_result))
            sys.exit(1)

        if not os.path.exists(args.audio_file):
            error_result = {"error": f"Audio file not found: {args.audio_file}", "success": False}
            print(json.dumps(error_result))
            sys.exit(1)

        # Transcribe
        result = transcribe_audio(args.audio_file, args.model, args.language, args.task)

        # Output results
        if args.output_format == "json":
            print(json.dumps(result))
        else:
            if result.get("success"):
                print(result.get("text", ""))
            else:
                print(f"Error: {result.get('error', 'Unknown error')}", file=sys.stderr)
                sys.exit(1)


if __name__ == "__main__":
    main()
