/**
 * Centralized Temp Directory Management
 * Ensures all temp files go to a single directory and sets environment variables
 * for libraries like Baileys and ffmpeg to use the same directory
 */

const fs = require('fs');
const path = require('path');

// Get the project root directory
const PROJECT_ROOT = process.cwd();

// Centralized temp directory (relative to project root)
const TEMP_DIR = path.join(PROJECT_ROOT, 'temp');

/**
 * Initialize temp directory system
 * MUST be called before any libraries that use temp directories are loaded
 */
function initializeTempSystem() {
  // Set environment variables BEFORE any libraries load
  // This ensures Baileys, ffmpeg, and other libraries use our temp directory
  const tempDirAbsolute = path.resolve(TEMP_DIR);
  
  // Set all common temp environment variables
  process.env.TMPDIR = tempDirAbsolute;
  process.env.TMP = tempDirAbsolute;
  process.env.TEMP = tempDirAbsolute;
  
  // Windows-specific
  if (process.platform === 'win32') {
    process.env.TEMP = tempDirAbsolute;
    process.env.TMP = tempDirAbsolute;
  }
  
  // Ensure temp directory exists
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
  
  return TEMP_DIR;
}

/**
 * Get the centralized temp directory path
 */
function getTempDir() {
  // Ensure it exists
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
  return TEMP_DIR;
}

/**
 * Create a safe temp file path
 * @param {string} prefix - File prefix
 * @param {string} extension - File extension (without dot)
 * @returns {string} Full path to temp file
 */
function createTempFilePath(prefix = 'temp', extension = 'tmp') {
  const tempDir = getTempDir();
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2);
  const filename = `${prefix}_${timestamp}_${random}.${extension}`;
  return path.join(tempDir, filename);
}

/**
 * Safely delete a temp file
 * @param {string} filePath - Path to file to delete
 * @returns {boolean} True if deleted successfully, false otherwise
 */
function deleteTempFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      // Only delete files in our temp directory for safety
      const resolvedPath = path.resolve(filePath);
      const tempDirResolved = path.resolve(TEMP_DIR);
      
      const relative = path.relative(tempDirResolved, resolvedPath);
      if (relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
        fs.unlinkSync(filePath);
        return true;
      } else {
        console.warn(`Attempted to delete file outside temp directory: ${filePath}`);
        return false;
      }
    }
    return false;
  } catch (error) {
    console.error(`Error deleting temp file ${filePath}:`, error.message);
    return false;
  }
}

/**
 * Delete multiple temp files
 * @param {string[]} filePaths - Array of file paths to delete
 */
function deleteTempFiles(filePaths) {
  if (!Array.isArray(filePaths)) return;
  
  filePaths.forEach(filePath => {
    deleteTempFile(filePath);
  });
}

// Files/stamps a running job still needs. The periodic cleanup and the memory
// watchdog skip anything whose name starts with a held key.
const held = new Map();

/** Protect `key` (a temp path or a job stamp prefix) until the returned fn is called. */
function holdTemp(key) {
  const k = path.basename(String(key || ''));
  if (!k) return () => {};
  held.set(k, (held.get(k) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (held.get(k) || 1) - 1;
    if (n <= 0) held.delete(k); else held.set(k, n);
  };
}

function isHeld(name) {
  const base = path.basename(String(name || ''));
  for (const k of held.keys()) if (base.startsWith(k)) return true;
  return false;
}

module.exports = {
  holdTemp,
  isHeld,
  initializeTempSystem,
  getTempDir,
  createTempFilePath,
  deleteTempFile,
  deleteTempFiles,
  TEMP_DIR
};

