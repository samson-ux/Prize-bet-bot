/**
 * PrizePicks DOM scraper.
 *
 * All selectors are centralized in SELECTORS for easy updating.
 * Two modes:
 *   1. Pre-game: scrape tomorrow's props across all sports
 *   2. Live: fast page.evaluate() to check a player's current line + goblin/demon
 *
 * NOTE: These selectors are best-effort based on PrizePicks' typical DOM structure.
 *       You WILL likely need to update them by inspecting the actual site.
 *       When a selector fails, the error message will tell you which one to fix.
 */

const createLogger = require('./logger');
const log = createLogger('SCRAPER');

// ─── CENTRALIZED SELECTORS ─────────────────────────────────────────────────
// Update these when PrizePicks changes their DOM.
const SELECTORS = {
  // Navigation / sport tabs
  sportTabs: '.sport-tab, [data-testid="sport-tab"], .category-tab',
  activeSportTab: '.sport-tab.active, [data-testid="sport-tab"][aria-selected="true"]',

  // Player projection cards
  projectionCard: '.projection-card, [data-testid="projection-card"], .stat-card',
  playerName: '.player-name, [data-testid="player-name"], .projection-card .name',
  statType: '.stat-type, [data-testid="stat-type"], .projection-card .stat',
  lineScore: '.line-score, [data-testid="line-score"], .projection-card .score, .presale-score',
  gameTime: '.game-time, [data-testid="game-time"], .start-time',
  teamInfo: '.team-info, [data-testid="team-info"], .matchup',

  // Goblin & Demon icons — check multiple possible selectors
  goblinIcon: [
    '.goblin-icon',
    '[data-testid="goblin-icon"]',
    '.promo-icon.goblin',
    'img[alt*="goblin" i]',
    'svg[data-icon="goblin"]',
    '.projection-card .special-icon.green',
    '[class*="goblin"]',
  ].join(', '),

  demonIcon: [
    '.demon-icon',
    '[data-testid="demon-icon"]',
    '.promo-icon.demon',
    'img[alt*="demon" i]',
    'svg[data-icon="demon"]',
    '.projection-card .special-icon.red',
    '[class*="demon"]',
  ].join(', '),

  // Search
  searchInput: 'input[placeholder*="Search" i], [data-testid="search-input"], .search-bar input',
  searchResult: '.search-result, [data-testid="search-result"], .search-dropdown .result',

  // Bet slip
  overButton: '[data-testid="over-button"], .over-btn, .pick-button.over, button:has-text("More"), button:has-text("Over")',
  underButton: '[data-testid="under-button"], .under-btn, .pick-button.under, button:has-text("Less"), button:has-text("Under")',
  addToSlip: '[data-testid="add-to-slip"], .add-pick-btn, .add-to-entry',
  betAmountInput: '[data-testid="bet-amount"], input[placeholder*="amount" i], .entry-fee input, .wager-input input',
  confirmBet: '[data-testid="confirm-bet"], .submit-entry, .confirm-btn, button:has-text("Submit"), button:has-text("Place")',

  // Live board
  liveTag: '.live-tag, [data-testid="live"], .live-indicator, .status-live',
  currentStat: '.current-stat, [data-testid="current-stat"], .live-stat-value',

  // Login detection
  loggedInIndicator: '.user-avatar, [data-testid="user-menu"], .profile-icon, .account-menu',
};

// ─── SCRAPER CLASS ──────────────────────────────────────────────────────────

class PrizePicksScraper {
  constructor(page) {
    this.page = page;
    this.refreshInterval = null;
    this.isRefreshing = false;
    this.pauseRefresh = false; // pause during bet placement
  }

  /**
   * Scrape tomorrow's props across all sports within a time window.
   * @param {string} startTime - e.g., "15:30" (3:30 PM ET)
   * @param {string} endTime - e.g., "21:00" (9:00 PM ET)
   * @returns {Array} clean props with no goblin/demon
   */
  async scrapeTomorrowProps(startTime = '15:30', endTime = '21:00') {
    log.info(`Scraping tomorrow's props (${startTime}-${endTime} ET, all sports)...`);
    const props = [];

    try {
      // Navigate to PrizePicks board
      await this.page.goto('https://app.prizepicks.com/board', {
        waitUntil: 'networkidle',
        timeout: 15000,
      });
      await this.page.waitForTimeout(2000);

      // Find all sport/category tabs
      const sportTabs = await this.page.$$(SELECTORS.sportTabs);
      const tabNames = [];

      for (const tab of sportTabs) {
        const name = await tab.textContent().catch(() => '');
        tabNames.push(name.trim());
      }

      log.info(`Found sport tabs: ${tabNames.join(', ')}`);

      // Iterate each sport tab
      for (let i = 0; i < sportTabs.length; i++) {
        try {
          await sportTabs[i].click();
          await this.page.waitForTimeout(1500);

          const sportName = tabNames[i] || `Sport${i}`;
          const sportProps = await this._scrapeCurrentBoard(sportName, startTime, endTime);
          props.push(...sportProps);
        } catch (err) {
          log.warn(`Error scraping tab ${tabNames[i]}: ${err.message}`);
        }
      }
    } catch (err) {
      log.error(`Failed to scrape props: ${err.message}`);
    }

    // Filter out any with goblin or demon
    const clean = props.filter((p) => !p.hasGoblin && !p.hasDemon);
    log.info(`Found ${props.length} total props, ${clean.length} clean (no goblin/demon)`);
    return clean;
  }

  /**
   * Scrape the currently visible board for player props.
   */
  async _scrapeCurrentBoard(sportName, startTime, endTime) {
    const results = [];

    const cards = await this.page.$$(SELECTORS.projectionCard);

    for (const card of cards) {
      try {
        const playerName = await card.$eval(
          SELECTORS.playerName.split(', ').find((s) => true) || SELECTORS.playerName,
          (el) => el.textContent?.trim()
        ).catch(() => null);

        const statType = await card.$eval(
          SELECTORS.statType.split(', ')[0],
          (el) => el.textContent?.trim()
        ).catch(() => null);

        const lineText = await card.$eval(
          SELECTORS.lineScore.split(', ')[0],
          (el) => el.textContent?.trim()
        ).catch(() => null);

        const gameTimeText = await card.$eval(
          SELECTORS.gameTime.split(', ')[0],
          (el) => el.textContent?.trim()
        ).catch(() => null);

        const teamText = await card.$eval(
          SELECTORS.teamInfo.split(', ')[0],
          (el) => el.textContent?.trim()
        ).catch(() => null);

        // Check for goblin and demon
        const hasGoblin = await card.$(SELECTORS.goblinIcon).then((el) => !!el);
        const hasDemon = await card.$(SELECTORS.demonIcon).then((el) => !!el);

        if (!playerName || !lineText) continue;

        const line = parseFloat(lineText);
        if (isNaN(line)) continue;

        // Filter by time window if we can parse the game time
        if (gameTimeText && !this._isInTimeWindow(gameTimeText, startTime, endTime)) {
          continue;
        }

        results.push({
          player: playerName,
          sport: sportName,
          stat: statType || 'Unknown',
          line,
          gameTime: gameTimeText || 'TBD',
          matchup: teamText || '',
          hasGoblin,
          hasDemon,
        });
      } catch (err) {
        // Skip cards we can't parse
      }
    }

    return results;
  }

  /**
   * Check if a game time string falls within our target window.
   * Handles formats like "3:30 PM", "15:30", "7:10 PM ET", etc.
   */
  _isInTimeWindow(timeStr, startTime, endTime) {
    try {
      // Extract hours and minutes from various formats
      const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      if (!match) return true; // Can't parse → include it

      let hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const ampm = match[3];

      if (ampm) {
        if (ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
        if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
      }

      const timeMinutes = hours * 60 + minutes;

      const [startH, startM] = startTime.split(':').map(Number);
      const [endH, endM] = endTime.split(':').map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      return timeMinutes >= startMinutes && timeMinutes <= endMinutes;
    } catch {
      return true; // Can't parse → include it to be safe
    }
  }

  /**
   * FAST live check: read a player's current stat, line, and goblin/demon status.
   * Uses page.evaluate() for speed (~100-200ms).
   * @param {string} playerName
   * @returns {{ line: number, currentStat: number, hasGoblin: boolean, hasDemon: boolean } | null}
   */
  async checkLivePlayer(playerName) {
    try {
      const selectors = SELECTORS;
      const result = await this.page.evaluate(
        ({ playerName, selectors }) => {
          // Find all projection cards
          const cardSelectors = selectors.projectionCard.split(', ');
          let cards = [];
          for (const sel of cardSelectors) {
            cards.push(...document.querySelectorAll(sel));
          }

          for (const card of cards) {
            // Check player name
            const nameSelectors = selectors.playerName.split(', ');
            let nameEl = null;
            for (const sel of nameSelectors) {
              nameEl = card.querySelector(sel);
              if (nameEl) break;
            }
            if (!nameEl) continue;

            const name = nameEl.textContent?.trim() || '';
            if (!name.toLowerCase().includes(playerName.toLowerCase())) continue;

            // Found the player — read line
            const lineSelectors = selectors.lineScore.split(', ');
            let lineEl = null;
            for (const sel of lineSelectors) {
              lineEl = card.querySelector(sel);
              if (lineEl) break;
            }
            const line = lineEl ? parseFloat(lineEl.textContent?.trim()) : null;

            // Read current stat (live)
            const statSelectors = selectors.currentStat.split(', ');
            let statEl = null;
            for (const sel of statSelectors) {
              statEl = card.querySelector(sel);
              if (statEl) break;
            }
            const currentStat = statEl ? parseInt(statEl.textContent?.trim(), 10) : 0;

            // Check goblin
            const goblinSelectors = selectors.goblinIcon.split(', ');
            let hasGoblin = false;
            for (const sel of goblinSelectors) {
              if (card.querySelector(sel.trim())) {
                hasGoblin = true;
                break;
              }
            }

            // Check demon
            const demonSelectors = selectors.demonIcon.split(', ');
            let hasDemon = false;
            for (const sel of demonSelectors) {
              if (card.querySelector(sel.trim())) {
                hasDemon = true;
                break;
              }
            }

            return { line, currentStat, hasGoblin, hasDemon, found: true };
          }

          return { found: false };
        },
        { playerName, selectors }
      );

      if (!result.found) {
        log.warn(`Player "${playerName}" not found on live board`);
        return null;
      }

      log.info(
        `${playerName}: line=${result.line}, current=${result.currentStat}, ` +
          `goblin=${result.hasGoblin}, demon=${result.hasDemon}`
      );
      return result;
    } catch (err) {
      log.error(`Live check failed for ${playerName}: ${err.message}`);
      return null;
    }
  }

  /**
   * Start periodic refresh of the live page.
   * Pauses during bet placement.
   */
  startPeriodicRefresh(intervalMs = 150000) {
    log.info(`Starting periodic refresh every ${intervalMs / 1000}s`);
    this.refreshInterval = setInterval(async () => {
      if (this.pauseRefresh || this.isRefreshing) return;
      this.isRefreshing = true;
      try {
        await this.page.reload({ waitUntil: 'networkidle', timeout: 10000 });
        log.info('Live page refreshed');
      } catch (err) {
        log.warn(`Refresh failed: ${err.message}`);
      }
      this.isRefreshing = false;
    }, intervalMs);
  }

  stopPeriodicRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /** Pause refresh (call before placing bet) */
  pause() {
    this.pauseRefresh = true;
  }

  /** Resume refresh (call after placing bet) */
  resume() {
    this.pauseRefresh = false;
  }
}

module.exports = { PrizePicksScraper, SELECTORS };
