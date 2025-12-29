# OpenWhispr - Codebase Structure & Architecture

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Electron App                          │
├─────────────────────────────────────────────────────────────┤
│  Main Process (Node.js)    │    Renderer Process (React)     │
│  - main.js                  │    - src/main.jsx               │
│  - preload.js               │    - src/App.jsx                │
│  - Manager Classes          │    - Vite dev server           │
│  - IPC Handlers             │    - UI Components             │
│  - Database Operations       │    - Hooks/Services            │
├─────────────────────────────────────────────────────────────┤
│                    Python Bridge                             │
│  - whisper_bridge.py (local Whisper)                       │
│  - llama-cpp (local models)                               │
└─────────────────────────────────────────────────────────────┘
```

## Core Managers (Main Process)

Each manager is a singleton class initialized in `main.js`:

| Manager | File | Purpose |
|---------|------|---------|
| `AudioManager` | `src/helpers/audioManager.js` | Audio recording, silence detection, RMS analysis |
| `ClipboardManager` | `src/helpers/clipboard.js` | Cross-platform paste (AppleScript fallback for macOS) |
| `DatabaseManager` | `src/helpers/database.js` | SQLite operations for transcription history |
| `DebugLogger` | `src/helpers/debugLogger.js` | File-based debug logging with timestamps |
| `EnvironmentManager` | `src/helpers/environment.js` | API key management via environment.js |
| `HotkeyManager` | `src/helpers/hotkeyManager.js` | Global hotkey registration (backtick default) |
| `GlobeKeyManager` | `src/helpers/globeKeyManager.js` | macOS Globe/Fn key dictation trigger |
| `IPCHandlers` | `src/helpers/ipcHandlers.js` | Centralized IPC handler registration |
| `MenuManager` | `src/helpers/menuManager.js` | Application menu configuration |
| `PythonInstaller` | `src/helpers/pythonInstaller.js` | Auto-install Python for local Whisper |
| `LlamaCppInstaller` | `src/helpers/llamaCppInstaller.js` | Local model installation |
| `TrayManager` | `src/helpers/tray.js` | System tray icon and menu |
| `WhisperManager` | `src/helpers/whisper.js` | Local Whisper process management |
| `WindowManager` | `src/helpers/windowManager.js` | Window creation and lifecycle |

## React Components Structure

### Main Application Components
- `App.jsx` - Main dictation interface with recording states
- `ControlPanel.tsx` - Full settings interface (URL-based route)
- `OnboardingFlow.tsx` - 8-step first-time setup wizard
- `SettingsPage.tsx` - Comprehensive settings interface
- `WhisperModelPicker.tsx` - Model selection and download UI

### UI Components (src/components/ui/)
Built with shadcn/ui + Radix UI:
- `button.tsx`, `input.tsx`, `textarea.tsx`, `select.tsx`
- `dialog.tsx`, `dropdown-menu.tsx`, `tabs.tsx`
- `card.tsx`, `badge.tsx`, `progress.tsx`
- `toggle.tsx`, `tooltip.tsx`, `label.tsx`

### Specialized Components
- `AIModelSelectorEnhanced.tsx` - Multi-provider model selection
- `UnifiedModelPicker.tsx` - Combined model picker UI
- `ProcessingModeSelector.tsx` - Local vs cloud mode toggle
- `HotkeyCapture.tsx`, `Keyboard.tsx` - Hotkey input
- `LanguageSelector.tsx` - 58 language support
- `TranscriptionItem.tsx` - History item display

## React Hooks (src/hooks/)

| Hook | Purpose |
|------|---------|
| `useAudioRecording.js` | MediaRecorder API wrapper with error handling |
| `useClipboard.ts` | Clipboard operations via IPC |
| `useDialogs.ts` | Electron dialog integration |
| `useHotkey.js` | Hotkey state management |
| `useLocalStorage.ts` | Type-safe localStorage wrapper |
| `usePermissions.ts` | System permission checks (microphone, accessibility) |
| `usePython.ts` | Python installation state |
| `useSettings.ts` | Application settings management |
| `useWhisper.ts` | Whisper model download/management |
| `useLocalModels.ts` | Local reasoning model management |
| `useWindowDrag.js` | Window dragging functionality |

## Services (src/services/)

- `ReasoningService.ts` - Main AI processing orchestration
  - Routes to OpenAI, Anthropic, Gemini, or local models
  - Handles agent name detection and removal
  - Latest models (Sept 2025): GPT-5, Claude Opus 4.1, Gemini 2.5
- `LocalReasoningService.ts` - Local model inference via llama-cpp
- `BaseReasoningService.ts` - Base class for reasoning services

## Configuration (src/config/)

- `constants.ts` - API endpoints, feature flags
- `aiProvidersConfig.ts` - AI provider configurations
- `InferenceConfig.ts` - Inference settings

## Types (src/types/)

- `electron.ts` - Electron API type definitions
- Additional types defined inline in components/services

## Utilities (src/utils/)

- `SecureCache.ts` - Secure in-memory caching
- `agentName.ts` - Agent name processing
- `debugLoggerRenderer.ts` - Renderer-side debug logging
- `formatBytes.ts` - File size formatting
- `languages.ts` - 58 language codes and labels
- `process.ts` - Process-related utilities
- `retry.ts` - Retry logic for API calls
- `hotkeys.ts` - Hotkey parsing and formatting

## Models (src/models/)

- `ModelRegistry.ts` - Whisper model registry and management
- `modelRegistryData.json` - Model metadata (sizes, URLs, etc.)

## Stores (src/stores/)

- `transcriptionStore.ts` - Transcription history state management

## Key Constants

### Audio/Silence Detection
```javascript
DEFAULT_SILENCE_THRESHOLD_MS = 1500  // 1.5 seconds
SILENCE_CHECK_INTERVAL_MS = 200        // Check every 200ms
AMBIENT_CALIBRATION_MS = 800           // Calibration period
SPEECH_TO_AMBIENT_RATIO = 2.5          // Speech threshold
SILENCE_TO_AMBIENT_RATIO = 1.3         // Silence threshold
MAX_ACCEPTABLE_AMBIENT_RMS = 0.15      // Max ambient noise
MIN_AMBIENT_RMS = 0.003                // Ambient noise floor
```

### Whisper Models
- `tiny`: 39MB - Fastest, lowest quality
- `base`: 74MB - Recommended balance
- `small`: 244MB - Better quality
- `medium`: 769MB - High quality
- `large`: 1.5GB - Best quality
- `turbo`: 809MB - Fast with good quality

## IPC Channel Patterns

### Main → Renderer (via preload.js)
| Channel | Purpose |
|---------|---------|
| `transcribe-local-whisper` | Local Whisper transcription |
| `getOpenAIKey` | Fetch OpenAI API key securely |
| `save-transcription` | Save to database |
| `paste-text` | Paste text at cursor |
| `log-reasoning` | Debug logging to terminal |
| Window/Dialog/Clipboard operations | Various system interactions |

### Renderer → Main (via window.api)
All methods exposed through `window.electronAPI` in preload.js

## Data Flow

### Recording Pipeline
```
1. User presses hotkey → AudioManager.startRecording()
2. MediaRecorder captures audio → chunks array
3. User presses hotkey again → stopRecording()
4. Create Blob → ArrayBuffer → Base64 → IPC
5. Main process writes to temp file
6. Whisper processes (local or API)
7. Result sent back via IPC
8. Optional: ReasoningService for AI enhancement
9. ClipboardManager.pasteText() → paste at cursor
10. DatabaseManager saves transcription
```

### Silence Detection Pipeline
```
1. AudioContext with AnalyserNode created
2. Every 200ms: checkAudioLevel() called
3. Calibration phase (800ms): Measure ambient noise
4. Active phase: Monitor RMS levels
5. If RMS < silence threshold for X ms → auto-stop
6. Cleanup: clearInterval, close AudioContext
```

## Files to Ignore When Editing

- `src/dist/` - Build output (auto-generated)
- `node_modules/` - Dependencies (auto-installed)
- `dist/` - Electron build output
- `.serena/` - Serena tool configuration

## Important File Locations

| Purpose | File |
|---------|------|
| Environment config | `.env` (copy from `env.example`) |
| Build config | `electron-builder.json` |
| Vite config | `src/vite.config.mjs` |
| ESLint config | `src/eslint.config.js` |
| Python bridge | `whisper_bridge.py` (root) |
| Entry points | `main.js`, `src/main.jsx` |
| Technical docs | `CLAUDE.md` |
| User docs | `README.md` |
| Troubleshooting | `TROUBLESHOOTING.md`, `DEBUG.md` |
| Changelog | `CHANGELOG.md` |
