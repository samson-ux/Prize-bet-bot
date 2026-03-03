/**
 * Human-like browser interaction utilities.
 * All timing parameters come from config.humanization.
 */

const createLogger = require('./logger');
const log = createLogger('HUMAN');

let config = {
  minActionDelay: 200,
  maxActionDelay: 800,
  minConfirmDelay: 1000,
  maxConfirmDelay: 2500,
  mouseMovementSteps: 10,
  clickOffsetRange: 12,
  typingMinDelay: 50,
  typingMaxDelay: 150,
};

function setConfig(humanConfig) {
  config = { ...config, ...humanConfig };
}

/** Promise-based random delay between min and max ms */
function randomDelay(min, max) {
  const ms = min + Math.random() * (max - min);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short action delay */
function actionDelay() {
  return randomDelay(config.minActionDelay, config.maxActionDelay);
}

/** Longer delay before confirming bets */
function confirmDelay() {
  return randomDelay(config.minConfirmDelay, config.maxConfirmDelay);
}

/**
 * Move mouse along a bezier curve from (x1,y1) to (x2,y2).
 * Simulates natural hand movement — not a straight line.
 */
async function humanMouseMove(page, x1, y1, x2, y2) {
  const steps = config.mouseMovementSteps + Math.floor(Math.random() * 5);

  // Random control points for a bezier curve
  const cpX = (x1 + x2) / 2 + (Math.random() - 0.5) * 100;
  const cpY = (y1 + y2) / 2 + (Math.random() - 0.5) * 100;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const inv = 1 - t;
    // Quadratic bezier
    const x = inv * inv * x1 + 2 * inv * t * cpX + t * t * x2;
    const y = inv * inv * y1 + 2 * inv * t * cpY + t * t * y2;
    await page.mouse.move(x, y);
    // Vary speed — slower at start and end
    const speedFactor = Math.sin(t * Math.PI);
    await randomDelay(2, 8 + (1 - speedFactor) * 12);
  }
}

/**
 * Click an element with random offset from center.
 * Moves mouse to the element first with a natural curve.
 */
async function humanClick(page, element) {
  const box = await element.boundingBox();
  if (!box) {
    log.error('Element has no bounding box — cannot click');
    throw new Error('Element not visible for clicking');
  }

  // Random offset from center within configured range
  const offsetX = (Math.random() - 0.5) * 2 * config.clickOffsetRange;
  const offsetY = (Math.random() - 0.5) * 2 * config.clickOffsetRange;
  const targetX = box.x + box.width / 2 + offsetX;
  const targetY = box.y + box.height / 2 + offsetY;

  // Get current mouse position (start from a reasonable spot if unknown)
  const startX = box.x + box.width / 2 + (Math.random() - 0.5) * 200;
  const startY = box.y + box.height / 2 + (Math.random() - 0.5) * 200;

  await humanMouseMove(page, startX, startY, targetX, targetY);

  // Brief hover pause before clicking (humans do this)
  await randomDelay(50, 200);

  await page.mouse.click(targetX, targetY);
}

/**
 * Type text character by character with random delays.
 * Occasionally pauses mid-word to simulate human typing.
 */
async function humanType(page, selector, text) {
  await page.click(selector);
  await randomDelay(100, 300);

  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    let delay = config.typingMinDelay + Math.random() * (config.typingMaxDelay - config.typingMinDelay);

    // Occasionally pause longer mid-word (10% chance)
    if (Math.random() < 0.1) {
      delay += 200 + Math.random() * 300;
    }

    await new Promise((r) => setTimeout(r, delay));
  }
}

/**
 * Sometimes do a small random scroll to look natural.
 */
async function maybeScroll(page) {
  if (Math.random() < 0.3) {
    const amount = (Math.random() - 0.5) * 200;
    await page.mouse.wheel(0, amount);
    await randomDelay(200, 500);
  }
}

module.exports = {
  setConfig,
  randomDelay,
  actionDelay,
  confirmDelay,
  humanMouseMove,
  humanClick,
  humanType,
  maybeScroll,
};
