# OpenWhispr - Project Overview

## Purpose

OpenWhispr is an open-source **desktop dictation application** that converts speech to text using OpenAI Whisper. It provides both local (privacy-focused) and cloud (OpenAI/Anthropic/Gemini API) processing options.

## Core Features

- **Global Hotkey**: Customizable hotkey (default: backtick `` ` ``) to start/stop dictation from anywhere
- **Multi-Provider AI Processing**: OpenAI, Anthropic Claude, Google Gemini, or local models
- **Agent Naming**: Personalize AI assistant with custom name for natural interactions
- **Privacy-First**: Local processing keeps voice data completely private
- **Automatic Pasting**: Transcribed text automatically pastes at cursor location
- **Draggable Interface**: Move the dictation panel anywhere on screen
- **Transcription History**: SQLite database stores all transcriptions locally
- **Model Management**: Download and manage local Whisper models (tiny, base, small, medium, large, turbo)
- **Cross-Platform**: macOS, Windows, Linux

## Tech Stack

### Frontend (Renderer Process)
- **React 19** - UI framework
- **TypeScript** - Type safety (new code uses TSX, legacy code is JSX)
- **Tailwind CSS v4** - Styling
- **Vite 6** - Build tool and dev server
- **shadcn/ui** - UI component library (Radix UI primitives)
- **Lucide React** - Icons

### Desktop Framework
- **Electron 36** - Desktop app framework with context isolation
- **Better-SQLite3** - Local database for transcription history
- **electron-updater** - Auto-updates

### Audio/Speech Processing
- **OpenAI Whisper** - Speech-to-text (local via Python bridge, cloud via API)
- **FFmpeg** - Audio processing (bundled via ffmpeg-static)
- **MediaRecorder API** - Browser audio capture

### Python Bridge
- **whisper_bridge.py** - Standalone Python script for local Whisper processing
- **llama-cpp** - Local model inference for reasoning features

## Architecture

### Process Separation
1. **Main Process** (Node.js/Electron):
   - `main.js` - Application entry point
   - Manager initialization (audio, clipboard, database, hotkey, etc.)
   - IPC handlers
   - Database operations
   - System tray

2. **Renderer Process** (React App):
   - `src/main.jsx` - React entry
   - UI components in `src/components/`
   - Hooks in `src/hooks/`
   - Services in `src/services/`

3. **Preload Script** (`preload.js`):
   - Secure IPC bridge between main and renderer
   - Exposes safe API via `window.api`

### Dual Window Architecture
- **Main Window**: Minimal overlay for dictation (draggable, always on top)
- **Control Panel**: Full settings interface
- Both use same React codebase with URL-based routing

### Audio Pipeline
```
MediaRecorder API → Blob → ArrayBuffer → Base64 → IPC → File → FFmpeg → Whisper
```

## Project Structure

```
open-whispr/
├── main.js                 # Electron main entry point
├── preload.js              # Secure IPC bridge
├── whisper_bridge.py       # Python bridge for local Whisper
├── package.json            # Dependencies and scripts
├── electron-builder.json   # Build configuration
├── src/                    # React app (renderer process)
│   ├── main.jsx           # React entry
│   ├── App.jsx            # Main dictation interface
│   ├── components/        # React components
│   │   ├── ui/            # shadcn/ui components
│   │   ├── ControlPanel.tsx
│   │   ├── OnboardingFlow.tsx
│   │   ├── SettingsPage.tsx
│   │   └── ...
│   ├── hooks/             # Custom React hooks
│   ├── helpers/           # Main process helpers (via IPC)
│   ├── services/          # Business logic services
│   ├── config/            # Configuration
│   ├── types/             # TypeScript types
│   └── utils/             # Utility functions
├── resources/             # Platform-specific resources
└── scripts/               # Build and setup scripts
```

## Key Directories

- **`src/components/`**: React UI components
- **`src/hooks/`**: Custom React hooks (useAudioRecording, useSettings, etc.)
- **`src/helpers/`**: Utility modules (audioManager, clipboard, database, etc.)
- **`src/services/`**: Business logic (ReasoningService for AI processing)
- **`src/config/`**: App configuration and constants
- **`src/types/`**: TypeScript type definitions
- **`resources/`**: Platform-specific build resources

## License

MIT License - Free to use, modify, and distribute for personal or commercial purposes.
