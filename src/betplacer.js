/**
 * Playwright bet placer with full anti-detection.
 *
 * - Launches Firefox with stealth settings
 * - Waits for manual user login
 * - Places first leg (pre-game) and second leg (live) with human-like behavior
 * - Runs idle mouse movements in background during inactive periods
 */

const { firefox } = require('playwright');
const humanizer = require('./humanizer');
const { SELECTORS } = require('./scraper');
const createLogger = require('./logger');

const log = createLogger('BET');

class BetPlacer {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.idleTimer = null;
    this.idlePaused = false; // pause idle movements during bet placement
    humanizer.setConfig(config.humanization || {});
  }

  /**
   * Launch browser with anti-detection measures.
   * Returns the page for use by other modules.
   */
  async launchBrowser() {
    log.info('Launching Firefox browser...');

    this.browser = await firefox.launch({
      headless: false,
      firefoxUserPrefs: {
        // Disable webdriver detection
        'dom.webdriver.enabled': false,
        // Disable telemetry
        'toolkit.telemetry.enabled': false,
        'datareporting.healthreport.uploadEnabled': false,
        // Disable navigator.webdriver
        'marionette.enabled': false,
      },
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0',
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    // Override navigator.webdriver for Firefox
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Remove Playwright-specific properties
      delete window.__playwright;
      delete window.__pw_manual;
    });

    this.page = await this.context.newPage();

    // Navigate to PrizePicks
    await this.page.goto('https://app.prizepicks.com', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    log.info('Firefox browser launched — please log in to PrizePicks');
    return this.page;
  }

  /**
   * Wait for the user to manually log in.
   * Polls for a logged-in indicator element.
   */
  async waitForLogin() {
    log.info('Waiting for user to log in...');

    // Poll for any logged-in indicator
    const selectors = SELECTORS.loggedInIndicator.split(', ');

    while (true) {
      for (const sel of selectors) {
        try {
          const el = await this.page.$(sel);
          if (el) {
            log.info('User logged in successfully');
            return;
          }
        } catch {
          // ignore
        }
      }

      // Also check URL — after login the URL typically changes
      const url = this.page.url();
      if (url.includes('/board') || url.includes('/lobby') || url.includes('/dashboard')) {
        log.info('User logged in (detected via URL)');
        return;
      }

      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /**
   * Place the first leg (pre-game throwaway pick).
   * Searches for the player, selects over on their prop, adds to slip, enters bet size.
   * Does NOT confirm — leaves the slip open for the second leg.
   */
  async placeFirstLeg(selection, betSize) {
    log.info(`Placing first leg: ${selection.player} Over ${selection.line} ${selection.stat}`);

    try {
      // Step 1: Navigate to the board if not already there
      if (!this.page.url().includes('/board')) {
        await this.page.goto('https://app.prizepicks.com/board', {
          waitUntil: 'networkidle',
          timeout: 15000,
        });
      }

      await humanizer.actionDelay();
      await humanizer.maybeScroll(this.page);

      // Step 2: Search for the player
      const searchEl = await this._findElement(SELECTORS.searchInput, 'search input');
      await humanizer.humanClick(this.page, searchEl);
      await humanizer.actionDelay();
      await humanizer.humanType(this.page, SELECTORS.searchInput.split(', ')[0], selection.player);
      await humanizer.actionDelay();

      // Step 3: Wait for search results and click the player
      await this.page.waitForSelector(SELECTORS.searchResult, { timeout: 5000 }).catch(() => {});
      await humanizer.randomDelay(500, 1000);

      const results = await this.page.$$(SELECTORS.searchResult);
      if (results.length === 0) {
        log.error('No search results found for player');
        return false;
      }

      // Click the first matching result
      await humanizer.humanClick(this.page, results[0]);
      await humanizer.actionDelay();

      // Step 4: Select "Over" on the prop
      const overBtn = await this._findElement(SELECTORS.overButton, 'Over button');
      await humanizer.humanClick(this.page, overBtn);
      await humanizer.actionDelay();

      // Step 5: Enter bet size
      const betInput = await this._findElement(SELECTORS.betAmountInput, 'bet amount input');
      await humanizer.humanClick(this.page, betInput);
      await humanizer.randomDelay(200, 400);

      // Clear existing value and type new amount
      await this.page.keyboard.press('Control+a');
      await humanizer.randomDelay(50, 150);
      await humanizer.humanType(
        this.page,
        SELECTORS.betAmountInput.split(', ')[0],
        String(betSize)
      );

      log.info(`First leg entered: ${selection.player} Over ${selection.line} ${selection.stat}, $${betSize}`);
      log.info('Slip is ready — do NOT confirm yet. Waiting for second leg...');
      return true;
    } catch (err) {
      log.error(`Failed to place first leg: ${err.message}`);
      return false;
    }
  }

  /**
   * Place the second leg (live bet on a 3-pointer).
   * This adds the player to the existing slip and confirms the bet.
   * SPEED IS CRITICAL — total budget ~2 seconds of human-like interaction.
   */
  async placeSecondLeg(playerName) {
    log.info(`Placing second leg: ${playerName} 3PT Over`);
    this.pauseIdle();

    try {
      await humanizer.randomDelay(100, 300);

      // Step 1: Search for the player
      const searchEl = await this._findElement(SELECTORS.searchInput, 'search input');
      await humanizer.humanClick(this.page, searchEl);
      await humanizer.randomDelay(100, 250);

      // Clear search and type player name
      await this.page.keyboard.press('Control+a');
      await humanizer.randomDelay(30, 80);

      // Type quickly — we're on a timer
      for (const char of playerName) {
        await this.page.keyboard.type(char);
        await humanizer.randomDelay(30, 80);
      }

      await humanizer.randomDelay(300, 600);

      // Step 2: Click the player from results
      const results = await this.page.$$(SELECTORS.searchResult);
      if (results.length === 0) {
        log.error(`No search results for "${playerName}"`);
        return false;
      }
      await humanizer.humanClick(this.page, results[0]);
      await humanizer.randomDelay(150, 350);

      // Step 3: Select "Over"
      const overBtn = await this._findElement(SELECTORS.overButton, 'Over button');
      await humanizer.humanClick(this.page, overBtn);
      await humanizer.randomDelay(200, 500);

      // Step 4: Brief review pause (human would glance at slip)
      await humanizer.randomDelay(300, 700);

      // Step 5: Confirm/submit the bet
      const confirmBtn = await this._findElement(SELECTORS.confirmBet, 'confirm button');
      await humanizer.humanClick(this.page, confirmBtn);

      log.info('Bet placed successfully!');
      return true;
    } catch (err) {
      log.error(`Failed to place second leg: ${err.message}`);
      return false;
    } finally {
      this.resumeIdle();
    }
  }

  /**
   * Find an element using comma-separated selector fallbacks.
   */
  async _findElement(selectorString, label) {
    const selectors = selectorString.split(', ');
    for (const sel of selectors) {
      try {
        const el = await this.page.$(sel.trim());
        if (el) return el;
      } catch {
        // try next selector
      }
    }
    throw new Error(`Could not find ${label}. Update SELECTORS in scraper.js. Tried: ${selectorString}`);
  }

  /**
   * Start random idle mouse movements in the background.
   * Moves the mouse to random spots on the page every 3-15 seconds,
   * occasionally scrolls, hovers over elements — simulates a real person
   * casually browsing while waiting.
   * Automatically pauses during bet placement.
   */
  startIdleMovement() {
    log.info('Starting idle mouse movement loop');
    this._runIdleLoop();
  }

  async _runIdleLoop() {
    while (true) {
      // Wait a random interval between movements (3-15 seconds)
      const waitMs = 3000 + Math.random() * 12000;
      await new Promise((r) => (this.idleTimer = setTimeout(r, waitMs)));

      // Skip if paused (bet is being placed) or browser is closed
      if (this.idlePaused || !this.page) continue;

      try {
        const action = Math.random();

        if (action < 0.35) {
          // Move mouse to a random position on the page
          const x = 100 + Math.random() * 1240;
          const y = 80 + Math.random() * 740;
          const fromX = 200 + Math.random() * 1000;
          const fromY = 100 + Math.random() * 600;
          await humanizer.humanMouseMove(this.page, fromX, fromY, x, y);
        } else if (action < 0.55) {
          // Small scroll up or down
          const amount = (Math.random() - 0.5) * 300;
          await this.page.mouse.wheel(0, amount);
          await humanizer.randomDelay(100, 400);
        } else if (action < 0.70) {
          // Move to a random visible element and hover
          const elements = await this.page.$$('a, button, [role="button"], .player-name, img');
          if (elements.length > 0) {
            const el = elements[Math.floor(Math.random() * elements.length)];
            const box = await el.boundingBox().catch(() => null);
            if (box) {
              const fromX = box.x + Math.random() * 300 - 150;
              const fromY = box.y + Math.random() * 300 - 150;
              const toX = box.x + box.width / 2 + (Math.random() - 0.5) * 10;
              const toY = box.y + box.height / 2 + (Math.random() - 0.5) * 10;
              await humanizer.humanMouseMove(this.page, fromX, fromY, toX, toY);
              // Hover pause — like reading text
              await humanizer.randomDelay(500, 2000);
            }
          }
        } else if (action < 0.80) {
          // Move mouse slowly across the page (like scanning content)
          const startX = 100 + Math.random() * 400;
          const startY = 200 + Math.random() * 400;
          const endX = startX + 300 + Math.random() * 600;
          const endY = startY + (Math.random() - 0.5) * 200;
          await humanizer.humanMouseMove(this.page, startX, startY, endX, endY);
        } else {
          // Do nothing — sometimes humans just sit there
          await humanizer.randomDelay(1000, 5000);
        }
      } catch {
        // Page might be navigating or element gone — just ignore
      }
    }
  }

  /** Pause idle movements (call before placing a bet) */
  pauseIdle() {
    this.idlePaused = true;
  }

  /** Resume idle movements (call after placing a bet) */
  resumeIdle() {
    this.idlePaused = false;
  }

  async close() {
    this.idlePaused = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.browser) {
      await this.browser.close();
      log.info('Browser closed');
    }
  }

  getPage() {
    return this.page;
  }
}

module.exports = BetPlacer;
