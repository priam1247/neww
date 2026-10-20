/**
 * ZaFar Bot — editable status cards (shared by .movie / .series)
 *
 * One message per job that is edited in place instead of spamming the chat.
 * Edits are throttled (WhatsApp rate-limits rapid edits) and every failure falls
 * back to a normal message, so the user always receives the final result.
 */

const DEFAULT_THROTTLE_MS = 4000;

/**
 * @param {object} sock  Baileys socket
 * @param {string} chatId
 * @param {object} msg   original message (for quoting)
 * @param {string} initialText
 * @param {{throttleMs?:number}} [opts]
 */
function progressCard(sock, chatId, msg, initialText, { throttleMs = DEFAULT_THROTTLE_MS } = {}) {
  let key = null;
  let disabled = false;
  let lastEdit = 0;
  let lastText = initialText;

  const ready = sock.sendMessage(chatId, { text: initialText }, { quoted: msg })
    .then((sent) => { key = sent?.key || null; return sent; })
    .catch(() => { disabled = true; return null; });

  const sendFresh = async (text) => {
    try { await sock.sendMessage(chatId, { text }, { quoted: msg }); } catch { /* ignore */ }
  };

  return {
    ready,

    /** Throttled edit; pass {force:true} for milestones. */
    async update(text, { force = false } = {}) {
      if (text === lastText) return;
      if (!force && Date.now() - lastEdit < throttleMs) return;
      await ready;
      if (disabled || !key) { lastText = text; return; }
      lastEdit = Date.now();
      lastText = text;
      try { await sock.sendMessage(chatId, { text, edit: key }); }
      catch { disabled = true; }
    },

    /** Final message: edits the card, or sends a fresh message if that fails. */
    async final(text) {
      await ready;
      if (disabled || !key) return sendFresh(text);
      try { return await sock.sendMessage(chatId, { text, edit: key }); }
      catch { disabled = true; return sendFresh(text); }
    },
  };
}

/** "⬇️ 320 MB (46%)" style progress line. */
function progressLine(got, total) {
  const mb = (got / 1048576).toFixed(0);
  if (!total) return `⬇️ ${mb} MB`;
  const pct = Math.min(100, Math.round((got / total) * 100));
  const filled = Math.round(pct / 10);
  return `⬇️ ${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${pct}%  (${mb}/${(total / 1048576).toFixed(0)} MB)`;
}

module.exports = { progressCard, progressLine };
