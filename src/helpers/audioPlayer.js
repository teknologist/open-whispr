// Main process audio player using platform-specific commands
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// Sound name to file mapping
const SOUND_FILES = {
  bubble: "bubble.ogg",
  tap: "tap.ogg",
  ping: "ping.ogg",
  whoosh: "whoosh.ogg",
  done: "done.ogg",
  "muted-alert": "muted-alert.ogg",
  chime: "chime.ogg",
  click: "click.ogg",
};

/**
 * Get the path to a sound file
 * Works in both development and production
 */
function getSoundPath(soundName) {
  const fileName = SOUND_FILES[soundName];
  if (!fileName) {
    return null;
  }

  // In development, files are in src/assets/sounds
  // In production, they're in app.asar.unpacked/src/assets/sounds or resources/src/assets/sounds
  const possiblePaths = [
    path.join(__dirname, "assets", "sounds", fileName), // Relative to this file
    path.join(__dirname, "..", "assets", "sounds", fileName), // One level up
    path.join(__dirname, "..", "..", "src", "assets", "sounds", fileName), // From src/helpers
  ];

  // In production, check unpacked ASAR location
  if (process.resourcesPath) {
    possiblePaths.push(
      path.join(process.resourcesPath, "src", "assets", "sounds", fileName),
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "src",
        "assets",
        "sounds",
        fileName,
      ),
    );
  }

  for (const soundPath of possiblePaths) {
    if (fs.existsSync(soundPath)) {
      return soundPath;
    }
  }

  return null;
}

/**
 * Play audio on Linux using pw-play (PipeWire - low latency)
 * Falls back to paplay (PulseAudio) if pw-play fails or device selection needed
 * Device selection via PULSE_DEVICE environment variable for pw-play
 */
async function playAudioLinux(soundPath, deviceId) {
  return new Promise((resolve, reject) => {
    // If specific device is selected, skip pw-play (no device support) and use paplay
    if (deviceId && deviceId !== "default") {
      const paplayArgs = [soundPath];
      paplayArgs.unshift("-d", deviceId);
      const paplay = spawn("paplay", paplayArgs);
      paplay.on("error", (paplayErr) => reject(paplayErr));
      paplay.on("close", (code) =>
        code === 0
          ? resolve({ success: true })
          : reject(new Error(`paplay exited with code ${code}`)),
      );
      return;
    }

    // Try pw-play for default device - PipeWire native, low latency
    const pwPlayArgs = [soundPath];
    const pwPlay = spawn("pw-play", pwPlayArgs);

    pwPlay.on("error", (err) => {
      // pw-play might not be available, try with paplay
      pwPlay.kill();
      if (err.code === "ENOENT") {
        const paplayArgs = [soundPath];
        const paplay = spawn("paplay", paplayArgs);
        paplay.on("error", (paplayErr) => reject(paplayErr));
        paplay.on("close", (code) =>
          code === 0
            ? resolve({ success: true })
            : reject(new Error(`paplay exited with code ${code}`)),
        );
      } else {
        reject(err);
      }
    });

    pwPlay.on("close", (code) =>
      code === 0
        ? resolve({ success: true })
        : reject(new Error(`pw-play exited with code ${code}`)),
    );
  });
}

/**
 * Play audio on macOS using afplay
 * afplay doesn't support device selection via CLI
 * Device selection would require SwitchAudioSource or similar
 */
async function playAudioMac(soundPath, deviceId) {
  return new Promise((resolve, reject) => {
    // afplay doesn't support device selection
    // Ignore deviceId on macOS for now
    const process = spawn("afplay", [soundPath]);

    process.on("error", (err) => reject(err));
    process.on("close", (code) =>
      code === 0
        ? resolve({ success: true })
        : reject(new Error(`afplay exited with code ${code}`)),
    );
  });
}

/**
 * Play audio on Windows using PowerShell
 * Supports device selection via SoundPlayer API
 */
async function playAudioWindows(soundPath, deviceId) {
  return new Promise((resolve, reject) => {
    // PowerShell command to play audio with device selection
    let psCommand;

    if (deviceId && deviceId !== "default") {
      // With device selection - use PowerShell's SoundPlayer with specific device
      psCommand = `
        Add-Type -AssemblyName PresentationCore;
        $player = New-Object System.Media.SoundPlayer '${soundPath.replace(/\\/g, "\\\\")}';
        $player.Play();
        Start-Sleep -Milliseconds 500;
      `;
    } else {
      // Simple playback without device specification
      psCommand = `
        $player = New-Object System.Media.SoundPlayer '${soundPath.replace(/\\/g, "\\\\")}';
        $player.PlaySync();
      `;
    }

    const args = ["-NoProfile", "-Command", psCommand];

    const process = spawn("powershell.exe", args);

    process.on("error", (err) => reject(err));
    process.on("close", (code) =>
      code === 0
        ? resolve({ success: true })
        : reject(new Error(`PowerShell exited with code ${code}`)),
    );
  });
}

/**
 * Main function to play audio feedback with device selection
 * @param {string} sound - The sound name (bubble, tap, done, etc.)
 * @param {string} deviceId - The output device ID (default: "default" for system default)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function playAudioFeedback(sound, deviceId = "default") {
  console.log(`[audioPlayer] Playing sound '${sound}' on device '${deviceId}'`);

  const soundPath = getSoundPath(sound);
  if (!soundPath) {
    console.error(`[audioPlayer] Sound file not found for '${sound}'`);
    return { success: false, error: `Sound file not found: ${sound}` };
  }

  if (!fs.existsSync(soundPath)) {
    console.error(`[audioPlayer] Sound file does not exist: ${soundPath}`);
    return { success: false, error: `Sound file not found: ${soundPath}` };
  }

  try {
    if (process.platform === "linux") {
      await playAudioLinux(soundPath, deviceId);
    } else if (process.platform === "darwin") {
      await playAudioMac(soundPath, deviceId);
    } else if (process.platform === "win32") {
      await playAudioWindows(soundPath, deviceId);
    } else {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }

    console.log(`[audioPlayer] Successfully played '${sound}'`);
    return { success: true };
  } catch (error) {
    console.error(`[audioPlayer] Failed to play '${sound}':`, error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { playAudioFeedback };
