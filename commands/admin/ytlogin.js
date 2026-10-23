'use strict';

const ytAuth = require('../../utils/ytAuth');
const config = require('../../config');

let _pendingLogin = null;

module.exports = {
  name: 'ytlogin',
  aliases: ['ytauth', 'ytoauth'],
  category: 'admin',
  description: 'Link Google TV OAuth for YouTube downloads',
  usage: '.ytlogin | .ytlogin status | .ytlogin off',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const sub = String(args[0] || '').toLowerCase();
    const P = config.prefix || '.';

    if (sub === 'status') {
      return extra.reply(`🔐 YouTube OAuth: ${ytAuth.hasYtCreds() ? 'linked' : 'none'}`);
    }

    if (['off', 'logout', 'clear', 'delete', 'remove'].includes(sub)) {
      ytAuth.clearYtCreds();
      return extra.reply('🔐 YouTube OAuth cleared.');
    }

    if (sub && sub !== 'start' && sub !== 'login') {
      return extra.reply(`Usage: ${P}ytlogin | ${P}ytlogin status | ${P}ytlogin off`);
    }

    if (_pendingLogin) {
      return extra.reply('⏳ A YouTube login code is already waiting for approval.');
    }

    let promptHandle = null;
    _pendingLogin = (async () => {
      try {
        await ytAuth.startYtLogin({
          onCode: async ({ verificationUrl, userCode }) => {
            const text = [
              '🔐 *YouTube Login*',
              `Open: ${verificationUrl}`,
              `Code: *${userCode}*`,
            ].join('\n');
            promptHandle = await extra.status(text);
          },
        });
        if (promptHandle) {
          await promptHandle.update('✅ YouTube account linked.');
        } else {
          await extra.reply('✅ YouTube account linked.');
        }
      } catch (err) {
        const line = `❌ ${err?.message || 'YouTube login failed.'}`;
        if (promptHandle) await promptHandle.update(line);
        else await extra.reply(line);
      } finally {
        _pendingLogin = null;
      }
    })();

    return _pendingLogin;
  },
};
