/**
 * Global Cleanup System
 * Automatically cleans up old temp files to prevent ENOSPC errors
 */

const fs = require('fs');
const path = require('path');
const { getTempDir } = require('./tempManager');
const config = require('../config');

// Cleanup interval: 10 minutes
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// File age threshold: 30 minutes for scraps, 2 hours for media jobs that can
// legitimately stay on disk while a big video is merging/uploading.
const FILE_AGE_THRESHOLD_MS = 30 * 60 * 1000;
const MEDIA_AGE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
// dl_/aud_ are .dl/.tiktok/.x/.spotify jobs (utils/mediaPipeline.js).
const MEDIA_PREFIX = /^(ytv_|song_|fb_|paper_|tg_|conv_|audio_|video_|dl_|aud_|mp3_)/;

const thresholdFor = (name) => (MEDIA_PREFIX.test(name) ? MEDIA_AGE_THRESHOLD_MS : FILE_AGE_THRESHOLD_MS);

// Session directory name (must NOT be cleaned)
const SESSION_DIR_NAME = config.sessionName || 'session';

let cleanupInterval = null;

/**
 * Clean up old temp files
 * Deletes files older than FILE_AGE_THRESHOLD_MS from temp directory
 * NEVER touches session directory
 */
function cleanupOldFiles() {
  try {
    const tempDir = getTempDir();
    
    // Safety check: ensure we're cleaning the right directory
    if (!fs.existsSync(tempDir)) {
      return;
    }
    
    const now = Date.now();
    let deletedCount = 0;
    let totalSizeFreed = 0;
    
    // Read all files in temp directory
    const files = fs.readdirSync(tempDir);
    
    for (const file of files) {
      const filePath = path.join(tempDir, file);
      
      try {
        // Skip directories (especially session directory if it somehow got here)
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          // Double-check: never touch session directory
          if (file === SESSION_DIR_NAME || filePath.includes(SESSION_DIR_NAME)) {
            continue;
          }
          continue;
        }
        
        // Check file age
        const fileAge = now - stats.mtimeMs;
        
        if (fileAge > thresholdFor(file)) {
          // File is older than threshold, delete it
          const fileSize = stats.size;
          fs.unlinkSync(filePath);
          deletedCount++;
          totalSizeFreed += fileSize;
        }
      } catch (error) {
        // Skip files that can't be accessed (might be in use)
        // Don't log errors for files that are being used
        if (!error.message.includes('ENOENT') && !error.message.includes('EBUSY')) {
          console.warn(`Error processing file ${filePath}:`, error.message);
        }
      }
    }
    
    if (deletedCount > 0) {
      const sizeMB = (totalSizeFreed / (1024 * 1024)).toFixed(2);
      console.log(`🧹 Cleanup: Deleted ${deletedCount} old temp file(s), freed ${sizeMB} MB`);
    }
  } catch (error) {
    // Don't crash on cleanup errors
    console.error('Error during cleanup:', error.message);
  }
}

/**
 * Start the cleanup system
 * Runs cleanup at startup and then every CLEANUP_INTERVAL_MS
 */
function startCleanup() {
  // Run cleanup immediately at startup
  console.log('🧹 Starting temp file cleanup system...');
  cleanupOldFiles();
  
  // Set up periodic cleanup
  cleanupInterval = setInterval(() => {
    cleanupOldFiles();
  }, CLEANUP_INTERVAL_MS);
  
  console.log(`✅ Cleanup system started (runs every ${CLEANUP_INTERVAL_MS / 1000 / 60} minutes)`);
}

/**
 * Stop the cleanup system
 */
function stopCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('🛑 Cleanup system stopped');
  }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  stopCleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopCleanup();
  process.exit(0);
});

module.exports = {
  cleanupOldFiles,
  startCleanup,
  stopCleanup
};

