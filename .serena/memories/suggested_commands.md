# OpenWhispr - Suggested Development Commands

## Essential Commands

### Development
```bash
npm run dev          # Start development with hot reload (Vite + Electron)
npm start           # Start production mode (no hot reload)
```

### Building
```bash
npm run build               # Full build for current platform
npm run build:renderer      # Build only frontend (Vite)
npm run pack                # Unsigned build (no certs needed)
                              # Output: dist/ directory
```

### Platform-Specific Builds
```bash
npm run build:mac           # macOS DMG + ZIP (x64/arm64)
npm run build:win           # Windows NSIS + portable
npm run build:linux         # Linux AppImage + deb + rpm + tar.gz
npm run dist                # Distribution build (signed if configured)
```

### Code Quality
```bash
npm run lint          # Run ESLint on src/ directory
# Fix linting issues manually or configure auto-fix
```

### Setup & Installation
```bash
npm install            # Install all dependencies
npm run setup         # Run first-time setup script
```

### Utilities
```bash
npm run clean         # Remove build artifacts and temp files
npm run preview       # Preview built renderer (Vite preview)
```

## Testing the Application

### Manual Testing Workflow
1. **Start dev server**: `npm run dev`
2. **Test silence detection**: 
   - Enable debug mode: `OPENWHISPR_DEBUG=true npm run dev`
   - Or use `--debug` flag
3. **Test local Whisper**: Ensure Python 3.7+ installed (auto-install available)
4. **Test cloud APIs**: Configure API keys in Control Panel or `.env`

### Debug Mode
```bash
# Enable debug logging for silence detection issues
OPENWHISPR_DEBUG=true npm start
# or
npm start -- --debug
```

## Git Workflow

### Common Git Commands
```bash
git status              # Check working tree status
git add .               # Stage all changes
git commit -m "msg"     # Commit changes
git push                # Push to origin
git log --oneline -5   # View recent commits
```

## Linux System Utilities

Since this is a Linux environment, these commands are frequently used:

### File Operations
```bash
ls -la                  # List all files (including hidden)
fd "pattern"            # Find files by pattern (faster than find)
rg "pattern"            # Search text content (ripgrep)
rg "pattern" -C 3       # Search with 3 lines of context
```

### Process Management
```bash
ps aux | grep electron   # Find running Electron processes
kill -9 <PID>           # Force kill a process by PID
lsof -i :5174           # Check what's using port 5174 (Vite dev server)
```

### Package Managers (Linux)
The app supports multiple Linux package managers for dependencies:
- `apt` (Debian/Ubuntu)
- `dnf`/`yum` (Fedora/RHEL)
- `zypper` (openSUSE)
- `pacman` (Arch Linux)

## Electron-Specific Commands

### Development Debugging
```bash
# Run with DevTools open
npm run dev:main

# Check for memory leaks
# Use Chrome DevTools Memory profiler when app is running
```

### Build Verification
```bash
# Verify build output
ls -la dist/
# Should see platform-specific directories (mac-arm64, win-unpacked, etc.)
```

## Python/LM Studio Commands

### Local Whisper Testing
```bash
# Test Python bridge directly
python3 whisper_bridge.py --help

# Check Whisper installation
python3 -c "import whisper; print(whisper.__version__)"
```

### Local Model Management
- Models stored in: `~/.cache/whisper/`
- LM Studio models used for reasoning features
- llama-cpp used for local inference

## Environment Configuration

### Environment Variables
Set these in `.env` file (copy from `env.example`):
```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
```

### Debug Variables
```bash
OPENWHISPR_DEBUG=true    # Enable verbose debug logging
NODE_ENV=development     # Development mode
```

## Platform-Specific Notes

### macOS
- Globe key support requires Xcode Command Line Tools
- Run `xcode-select --install` if needed
- Code signing: Uses HeroTools Inc. certificate (9R85XFMH59)

### Windows
- NSIS installer used for distribution
- Can build unsigned with `CSC_IDENTITY_AUTO_DISCOVERY=false`

### Linux
- Multiple package formats: AppImage, deb, rpm, tar.gz, Flatpak
- Model cleanup script: `resources/linux/after-remove.sh`

## Quick Reference for Common Tasks

| Task | Command |
|------|---------|
| Start dev server | `npm run dev` |
| Build for distribution | `npm run dist` |
| Quick unsigned build | `npm run pack` |
| Run linter | `npm run lint` |
| Clean build artifacts | `npm run clean` |
| Check git status | `git status` |
| Find a file | `fd "filename"` |
| Search code | `rg "pattern"` |
| Debug mode | `OPENWHISPR_DEBUG=true npm start` |
