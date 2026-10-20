// index.js — panel-friendly entry point.
// Pterodactyl (and most game-panel) eggs default to `JS_FILE=index.js`, so this
// shim keeps `exec node index.js` working with zero panel configuration.
import './bot.js';
