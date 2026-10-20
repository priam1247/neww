/**
 * Instagram Downloader - Using ruhend-scraper
 */

const config = require('../../config');
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_BYTES = 100 * 1024 * 1024;

// Download the media ourselves (Instagram/CDN links often fail when WhatsApp fetches them)
async function fetchMedia(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxRedirects: 5,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
    headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://www.instagram.com/' }
  });
  return Buffer.from(res.data);
}

// Detect the real type from the file header, not from the URL
// (CDN links end in ?query strings, so extension checks miss videos)
function sniffType(buf) {
  if (!buf || buf.length < 12) return null;
  const at = (a, b) => buf.toString('latin1', a, b);
  if (at(4, 8) === 'ftyp') {
    return ['heic', 'heix', 'mif1', 'avif'].includes(at(8, 12)) ? null : 'video';
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image';
  if (at(1, 4) === 'PNG') return 'image';
  if (at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP') return 'image';
  if (at(0, 3) === 'GIF') return 'image';
  return null;
}

// Store processed message IDs to prevent duplicates
const processedMessages = new Set();

// Function to extract unique media URLs with simple deduplication
function extractUniqueMedia(mediaData) {
  const uniqueMedia = [];
  const seenUrls = new Set();
  
  for (const media of mediaData) {
    if (!media.url) continue;
    
    // Only check for exact URL duplicates
    if (!seenUrls.has(media.url)) {
      seenUrls.add(media.url);
      uniqueMedia.push(media);
    }
  }
  
  return uniqueMedia;
}

// Function to validate media URL
function isValidMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  
  // Accept any URL that looks like media
  return url.includes('cdninstagram.com') || 
         url.includes('instagram') || 
         url.includes('http');
}

module.exports = {
  name: 'instagram',
  aliases: ['ig', 'insta', 'igdl', 'reels'],
  category: 'media',
  description: 'Download Instagram photos/videos/reels',
  usage: '<Instagram URL>',
  
  async execute(sock, msg, args, extra) {
    try {
      const chatId = extra.from;
      
      // Check if message has already been processed
      if (processedMessages.has(msg.key.id)) {
        return;
      }
      
      // Add message ID to processed set
      processedMessages.add(msg.key.id);
      
      // Clean up old message IDs after 5 minutes
      setTimeout(() => {
        processedMessages.delete(msg.key.id);
      }, 5 * 60 * 1000);
      
      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text ||
                   args.join(' ');
      
      if (!text) {
        return extra.reply('Please provide an Instagram link for the video.');
      }
      
      // Check for various Instagram URL formats
      const instagramPatterns = [
        /https?:\/\/(?:www\.)?instagram\.com\//,
        /https?:\/\/(?:www\.)?instagr\.am\//,
        /https?:\/\/(?:www\.)?instagram\.com\/p\//,
        /https?:\/\/(?:www\.)?instagram\.com\/reel\//,
        /https?:\/\/(?:www\.)?instagram\.com\/tv\//
      ];
      
      const isValidUrl = instagramPatterns.some(pattern => pattern.test(text));
      
      if (!isValidUrl) {
        return extra.reply('That is not a valid Instagram link. Please provide a valid Instagram post, reel, or video link.');
      }
      
      await sock.sendMessage(chatId, {
        react: { text: '📥', key: msg.key }
      });
      
      let mediaData = null;
      try {
        const { igdl } = require('ruhend-scraper'); // lazy: heavy dep only when command runs
        const downloadData = await igdl(text);
        if (downloadData && Array.isArray(downloadData.data) && downloadData.data.length) {
          mediaData = downloadData.data;
        }
      } catch (e) {
        console.warn('[instagram] scraper failed:', e.message);
      }

      // Fallback: cobalt handles Instagram too (a dead scraper used to make the
      // whole command useless even though a working engine was configured).
      if (!mediaData || !mediaData.length) {
        try {
          const providers = require('../../utils/downloadProviders');
          const hit = await providers.resolveMedia(text, { kind: 'video', timeoutMs: 20000 });
          await extra.reply('⏳ Primary source failed — using a backup source…');
          const buf = await fetchMedia(hit.url);
          const type = sniffType(buf) || (hit.ext === 'jpg' || hit.ext === 'png' ? 'image' : 'video');
          const caption = `*DOWNLOADED BY ${config.botName.toUpperCase()}*`;
          if (type === 'video') {
            await sock.sendMessage(chatId, { video: buf, mimetype: 'video/mp4', caption }, { quoted: msg });
          } else {
            await sock.sendMessage(chatId, { image: buf, caption }, { quoted: msg });
          }
          return;
        } catch (e) {
          console.warn('[instagram] backup source failed:', e.message);
        }
        return extra.reply('❌ No media found at the provided link. The post might be private, or the link is invalid.');
      }
      
      // Simple deduplication - just remove exact URL duplicates
      const uniqueMedia = extractUniqueMedia(mediaData);
      
      // Limit to maximum 20 unique media items
      const mediaToDownload = uniqueMedia.slice(0, 20);
      
      if (mediaToDownload.length === 0) {
        return extra.reply('❌ No valid media found to download. This might be a private post or the scraper failed.');
      }
      
      // Download each item, detect its real type, then send it
      let failed = 0;
      for (let i = 0; i < mediaToDownload.length; i++) {
        try {
          const buf = await fetchMedia(mediaToDownload[i].url);
          const type = sniffType(buf);
          const caption = `*DOWNLOADED BY ${config.botName.toUpperCase()}*`;

          if (type === 'video') {
            await sock.sendMessage(chatId, { video: buf, mimetype: 'video/mp4', caption }, { quoted: msg });
          } else if (type === 'image') {
            await sock.sendMessage(chatId, { image: buf, caption }, { quoted: msg });
          } else {
            throw new Error('Unrecognised or blocked media file');
          }

          // Small delay between downloads to prevent rate limiting
          if (i < mediaToDownload.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

        } catch (mediaError) {
          failed++;
          console.error(`Error downloading media ${i + 1}:`, mediaError.message);
          // Continue with next media if one fails
        }
      }

      if (failed) {
        await extra.reply(`⚠️ ${failed} of ${mediaToDownload.length} items could not be downloaded.`);
      }
    } catch (error) {
      console.error('Error in Instagram command:', error);
      await extra.reply('❌ An error occurred while processing the Instagram request. Please try again.');
    }
  }
};
