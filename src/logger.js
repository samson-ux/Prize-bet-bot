/**
 * Timestamped logger with module tags.
 * Also emits log events on a shared bus for the dashboard to consume.
 *
 * Usage: const log = require('./logger')('MODULE_NAME');
 *        log.info('message');
 */

const EventEmitter = require('events');

// Global log bus — dashboard subscribes to this
const logBus = new EventEmitter();
logBus.setMaxListeners(50);

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
      const line = `[${timestamp()}] [${tag}] ${msg}`;
      process.stdout.write(line + '\n');
      logBus.emit('log', { level: 'info', module: tag, msg, line });
    },
    warn(msg) {
      const line = `[${timestamp()}] [${tag}] ⚠ ${msg}`;
      process.stdout.write(line + '\n');
      logBus.emit('log', { level: 'warn', module: tag, msg, line });
    },
    error(msg) {
      const line = `[${timestamp()}] [${tag}] ERROR: ${msg}`;
      process.stderr.write(line + '\n');
      logBus.emit('log', { level: 'error', module: tag, msg, line });
    },
  };
}

createLogger.logBus = logBus;
module.exports = createLogger;
