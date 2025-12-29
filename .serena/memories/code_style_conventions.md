# OpenWhispr - Code Style and Conventions

## File Type Conventions

### TypeScript vs JavaScript
- **New React components**: Use `.tsx` extension
- **Legacy React components**: Use `.jsx` extension (being migrated)
- **Main process files**: Use `.js` extension (Electron main process)
- **Configuration**: Use `.js` or `.mjs` for config files
- **Python scripts**: Use `.py` extension

### TypeScript Patterns

When writing TypeScript:
- Use ES modules (import/export)
- Prefer `interface` for object shapes, `type` for unions/primitives
- Use JSDoc comments for function documentation
- Example:
  ```typescript
  interface TranscriptionResult {
    success: boolean;
    text?: string;
    error?: string;
  }
  
  /**
   * Process audio and return transcription
   * @param audioBlob - The audio data to transcribe
   * @returns Promise with transcription result
   */
  async function processAudio(audioBlob: Blob): Promise<TranscriptionResult>
  ```

## Code Style

### JavaScript/TypeScript
- **ES2020+ syntax**: async/await, arrow functions, template literals
- **Import style**: Named imports preferred, default exports for components
  ```typescript
  import { useState, useEffect } from 'react';
  import MyComponent from './MyComponent';
  ```
- **Variable naming**:
  - camelCase for variables and functions
  - PascalCase for classes, components, interfaces
  - UPPER_SNAKE_CASE for constants
  - Prefix private/internal properties with underscore: `_isStopping`

### React Components
- **Functional components with hooks** (no class components)
- **Props destructuring**:
  ```typescript
  function MyComponent({ title, onAction, children }) {
  ```
- **Event handlers**: Prefix with `on` (onClick, onSubmit, onChange)
- **Boolean props**: Prefix with `is`, `has`, `should` (isVisible, hasError)

### Naming Conventions

#### Files and Directories
- Components: PascalCase (`ControlPanel.tsx`, `SettingsPage.tsx`)
- Hooks: camelCase with `use` prefix (`useAudioRecording.ts`)
- Utils/Helpers: camelCase (`formatBytes.ts`, `hotkeys.ts`)
- Constants: UPPER_SNAKE_CASE (`API_ENDPOINTS`, `DEFAULT_SILENCE_THRESHOLD`)

#### Managers and Services
- Main process managers: PascalCase class name, camelCase file name
  - File: `src/helpers/audioManager.js`
  - Class: `class AudioManager`
- Services: PascalCase with `Service` suffix
  - `ReasoningService.ts`, `LocalReasoningService.ts`

## Code Organization

### Symbol-Based Editing (Serena Workflow)
When editing code:
1. Use `find_symbol` to locate the symbol (class, function, method)
2. Use `find_referencing_symbols` to find usages before editing
3. Use `replace_symbol_body` to replace entire symbols
4. Use `replace_content` for small edits within larger symbols

### Import Order
1. React/core imports
2. Third-party npm packages
3. Local components (absolute imports with `@`)
4. Relative imports
5. Types (if separate)

```typescript
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { MyHelper } from '../utils/myHelper';
import type { MyType } from '../types';
```

## ESLint Configuration

- Config file: `src/eslint.config.js`
- Uses `@eslint/js` with React plugins
- Key rules:
  - `no-unused-vars`: Error on unused vars (ignore UPPER_SNAKE_CASE)
  - `react-hooks/rules`: Enforces React Hooks rules
  - `react-refresh/only-export-components`: Warn if non-components exported

## Platform-Specific Patterns

### Main Process (Node.js/Electron)
- Use CommonJS `require()` for modules (not ES imports in main.js)
- Use `module.exports` or `exports` for exports
- Example:
  ```javascript
  const { app, BrowserWindow } = require('electron');
  const ClipboardManager = require('./src/helpers/clipboard');
  module.exports = { setupClipboardHandlers };
  ```

### Renderer Process (React App)
- Use ES modules (import/export)
- Access Electron APIs via `window.api` (exposed by preload.js)
- Example:
  ```typescript
  const result = await window.electronAPI.someMethod();
  ```

## Debug Logging

### Main Process
```javascript
const debugLogger = require('./debugLogger');

debugLogger.log("Context message", { data });
debugLogger.error("Error:", error);
debugLogger.logReasoning("STAGE_NAME", { details });
```

### Renderer Process
```javascript
// Check debug mode first
const isDebugMode = process.env.OPENWHISPR_DEBUG === "true";

if (isDebugMode) {
  console.log("[Component] Debug message");
}

// For terminal logging (via IPC)
await window.electronAPI?.logReasoning?.("STAGE", { details });
```

## IPC Patterns

### Main Process (ipcHandlers.js)
```javascript
ipcMain.handle('channel-name', async (event, arg1, arg2) => {
  // Handler logic
  return { success: true, data };
});
```

### Renderer Process
```typescript
// Call via exposed API
const result = await window.electronAPI.channelName(arg1, arg2);
```

## Security Considerations

- **Context isolation enabled**: No direct Node.js access in renderer
- **API keys**: Stored securely via environment.js, never in renderer code
- **File paths**: Always validate and sanitize
- **IPC surface area**: Keep minimal, validate all inputs

## Design Patterns

### Manager Pattern
Main process managers are singletons initialized in main.js:
- `audioManager` - Audio device and silence detection
- `clipboardManager` - Cross-platform clipboard operations
- `databaseManager` - SQLite operations
- `hotkeyManager` - Global hotkey registration
- `windowManager` - Window creation and lifecycle
- `trayManager` - System tray integration

### Service Pattern
Business logic services in renderer process:
- `ReasoningService` - AI processing orchestration
- `LocalReasoningService` - Local model inference

### React Hook Pattern
Custom hooks encapsulate stateful logic:
- `useAudioRecording` - MediaRecorder wrapper
- `useSettings` - Settings persistence
- `useLocalStorage` - Type-safe localStorage wrapper
- `usePermissions` - System permission checks
