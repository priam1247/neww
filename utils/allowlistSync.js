/**
 * Compatibility wrapper for `utils/dashboardSync.js`.
 * Kept in-tree so existing imports and SFTP deployments continue working cleanly.
 */

'use strict';

const { startDashboardSync, triggerImmediateSync } = require('./dashboardSync');

function startAllowlistSync(opts = {}) {
  return startDashboardSync(opts);
}

module.exports = { startAllowlistSync, triggerImmediateSync };
