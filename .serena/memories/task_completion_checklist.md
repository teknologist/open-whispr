# OpenWhispr - Task Completion Checklist

When a coding task is completed, follow these steps to ensure quality and maintainability.

## Immediate Post-Task Steps

### 1. Code Quality
- [ ] Run linter: `npm run lint`
  - Fix any linting errors
  - Address warnings if they impact code quality
- [ ] No console.log statements left in production code (use debug mode checks)
- [ ] Verify no hardcoded secrets (API keys, credentials)

### 2. Build Verification
- [ ] Build the renderer: `npm run build:renderer`
  - Ensure build completes without errors
  - Check for TypeScript errors
- [ ] Full build test: `npm run build` (if platform-specific changes)
- [ ] Test the application in dev mode: `npm run dev`

### 3. Functional Testing
- [ ] Test modified features manually
- [ ] Test silence detection if audio-related changes
- [ ] Verify hotkey functionality still works
- [ ] Check Control Panel functionality
- [ ] Test both local and cloud processing modes (if applicable)

### 4. Debug Logging
- [ ] Verify debug logs work: `OPENWHISPR_DEBUG=true npm start`
- [ ] Ensure production mode has no console spam
- [ ] Check debug logger writes to file correctly

### 5. Git Workflow
- [ ] Review changes: `git diff` and `git diff --cached`
- [ ] Stage relevant files: `git add <files>`
- [ ] Write meaningful commit message following conventional commit format:
  - `feat:` for new features
  - `fix:` for bug fixes
  - `refactor:` for code restructuring
  - `chore:` for maintenance tasks
  - `docs:` for documentation
  - `style:` for formatting changes
  - `test:` for tests
  - `perf:` for performance improvements

## Commit Message Format

### Structure
```
type(scope): subject

body (optional)

footer (optional)
```

### Examples
```
feat(audio): add configurable silence auto-stop

- Add AMBIENT_CALIBRATION_MS constant for noise measurement
- Implement adaptive RMS threshold for silence detection
- Add user settings for enabling/disabling feature

Fixes #123

fix(hotkey): resolve global hotkey not working on Linux

- Use electron-globalShortcut correctly
- Add proper cleanup on app quit
- Test on Ubuntu 22.04 and Fedora 37

refactor(audio): wrap console logs with debug mode checks

All console.log/warn/error now respect OPENWHISPR_DEBUG
environment variable to prevent console spam in production.
```

## Special Considerations by Component Type

### Audio/Silence Detection Changes
- [ ] Test with various microphone inputs
- [ ] Verify in noisy environments (use OPENWHISPR_DEBUG=true)
- [ ] Check auto-stop triggers correctly
- [ ] Test speech detection timing

### IPC Handler Changes
- [ ] Verify preload.js exposes the new API
- [ ] Test error handling in renderer
- [ ] Check for race conditions
- [ ] Verify cleanup on window close

### UI Component Changes
- [ ] Test on different window sizes
- [ ] Verify keyboard navigation
- [ ] Check accessibility (aria labels where needed)
- [ ] Test in both main window and Control Panel

### Database Changes
- [ ] Verify migration path if schema changed
- [ ] Test data persistence
- [ ] Check for SQL injection vulnerabilities
- [ ] Verify cleanup works correctly

### Build/Configuration Changes
- [ ] Test on all target platforms (if possible)
- [ ] Verify ASAR unpacking for necessary files
- [ ] Check electron-builder configuration
- [ ] Test production build: `npm run dist`

## Pre-Push Checklist

Before pushing changes to remote:
1. [ ] All linting issues resolved
2. [ ] Application builds successfully
3. [ ] Manual testing completed for affected features
4. [ ] No sensitive data in commits
5. [ ] Commit message follows conventions
6. [ ] Changes reviewed (self-review or peer review)

## Code Review Points

When reviewing changes (your own or others'):
- **Security**: No hardcoded credentials, proper input validation
- **Performance**: No memory leaks, proper cleanup, efficient algorithms
- **Error Handling**: Errors caught and handled appropriately with user feedback
- **Code Style**: Follows project conventions, consistent formatting
- **Documentation**: Complex logic has comments explaining "why"
- **Testing**: Edge cases considered and handled

## Platform-Specific Testing

If changes affect platform-specific code:
- [ ] **macOS**: Test on Intel and Apple Silicon if possible
- [ ] **Windows**: Test NSIS installer if build changes
- [ ] **Linux**: Test package manager integration if relevant

## Continuous Improvement

After task completion:
- [ ] Document any new patterns or decisions in CLAUDE.md
- [ ] Update CHANGELOG.md if user-facing feature added
- [ ] Consider adding tests for critical functionality (future work)
- [ ] Note any technical debt for future refactoring

## Common Issues to Watch For

1. **Memory Leaks**: Check that intervals/timeouts are cleared
2. **Race Conditions**: Ensure async operations properly awaited
3. **Resource Leaks**: Verify file handles, streams, connections closed
4. **Context Loss**: Don't lose `this` context in callbacks
5. **Missing Error Handling**: All async operations should have try/catch
6. **Debug Logs**: Must be guarded by `isDebugMode` or `debugLogger.isEnabled()`

## Task Handoff

If passing work to another developer or AI:
- Document what was done and why
- List any remaining issues or known limitations
- Point to related code that may need updating
- Include testing instructions for modified features
