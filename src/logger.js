/**
 * Timestamped logger with module tags.
 * Usage: const log = require('./logger')('MODULE_NAME');
 *        log.info('message');
 */

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function timestamp() {
  const now = new Date();
  const h = pad(now.getHours(), 2);
  const m = pad(now.getMinutes(), 2);
  const s = pad(now.getSeconds(), 2);
  const ms = pad(now.getMilliseconds(), 3);
  return `${h}:${m}:${s}.${ms}`;
}

function createLogger(module) {
  const tag = module.toUpperCase();

  return {
    info(msg) {
      process.stdout.write(`[${timestamp()}] [${tag}] ${msg}\n`);
    },
    warn(msg) {
      process.stdout.write(`[${timestamp()}] [${tag}] ⚠ ${msg}\n`);
    },
    error(msg) {
      process.stderr.write(`[${timestamp()}] [${tag}] ERROR: ${msg}\n`);
    },
  };
}

module.exports = createLogger;
