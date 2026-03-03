/**
 * Decision Engine — the brain connecting audio detection to bet placement.
 *
 * - Tracks 3-pointer counts per player (from parser events)
 * - On "made" event: checks PrizePicks live board for line + goblin/demon
 * - If player hits their line AND no goblin AND no demon → places the bet
 * - Conservative: skips if ANY doubt
 */

const createLogger = require('./logger');
const log = createLogger('ENGINE');

class DecisionEngine {
  /**
   * @param {PrizePicksScraper} scraper
   * @param {BetPlacer} betPlacer
   */
  constructor(scraper, betPlacer) {
    this.scraper = scraper;
    this.betPlacer = betPlacer;

    // player name → { threeCount, lastUpdated }
    this.playerStats = new Map();

    // Prevent duplicate bets on the same player
    this.betPlaced = new Set();

    // Lock to prevent concurrent bet placement
    this.placingBet = false;
  }

  /**
   * Handle a shot event from the parser.
   * @param {{ player: string, result: 'made' | 'missed' | 'unknown' }} event
   */
  async handleShot(event) {
    const { player, result } = event;

    if (result === 'unknown') {
      log.warn(`${player}: result unknown — skipping (NO BET)`);
      return;
    }

    // Initialize player stats if needed
    if (!this.playerStats.has(player)) {
      this.playerStats.set(player, { threeCount: 0, lastUpdated: Date.now() });
    }

    const stats = this.playerStats.get(player);

    if (result === 'missed') {
      log.info(`${player}: missed 3PT. Count stays at ${stats.threeCount}`);
      return;
    }

    // result === 'made'
    stats.threeCount += 1;
    stats.lastUpdated = Date.now();
    log.info(`${player}: MADE 3PT! Count: ${stats.threeCount - 1} → ${stats.threeCount}`);

    // Check if we already placed a bet on this player
    if (this.betPlaced.has(player)) {
      log.info(`${player}: bet already placed — skipping`);
      return;
    }

    // Check if another bet is currently being placed
    if (this.placingBet) {
      log.warn(`${player}: another bet is being placed — skipping`);
      return;
    }

    // Query PrizePicks live board for this player
    log.info(`${player}: checking PrizePicks live board...`);
    const liveData = await this.scraper.checkLivePlayer(player);

    if (!liveData) {
      log.warn(`${player}: not found on live board — cannot bet`);
      return;
    }

    // Check goblin
    if (liveData.hasGoblin) {
      log.warn(`${player}: HAS GOBLIN — NO BET`);
      return;
    }

    // Check demon
    if (liveData.hasDemon) {
      log.warn(`${player}: HAS DEMON — NO BET`);
      return;
    }

    // Check if player's count exceeds the line
    if (liveData.line === null || liveData.line === undefined) {
      log.warn(`${player}: could not read line from live board — NO BET`);
      return;
    }

    if (stats.threeCount > liveData.line) {
      log.info(
        `${player}: ${stats.threeCount} > ${liveData.line} — PLACING BET!`
      );

      this.placingBet = true;
      this.scraper.pause(); // stop page refreshes during bet

      try {
        const success = await this.betPlacer.placeSecondLeg(player);
        if (success) {
          log.info(`${player}: BET PLACED SUCCESSFULLY`);
          this.betPlaced.add(player);
        } else {
          log.error(`${player}: bet placement FAILED`);
        }
      } catch (err) {
        log.error(`${player}: bet placement error: ${err.message}`);
      } finally {
        this.placingBet = false;
        this.scraper.resume();
      }
    } else {
      log.info(
        `${player}: ${stats.threeCount} <= ${liveData.line} — not at line yet, waiting...`
      );
    }
  }

  /**
   * Get current stats for all tracked players.
   */
  getStats() {
    const result = {};
    for (const [player, stats] of this.playerStats) {
      result[player] = {
        threeCount: stats.threeCount,
        betPlaced: this.betPlaced.has(player),
      };
    }
    return result;
  }

  /**
   * Manually set a player's count (e.g., from API backup).
   */
  setPlayerCount(player, count) {
    if (!this.playerStats.has(player)) {
      this.playerStats.set(player, { threeCount: 0, lastUpdated: Date.now() });
    }
    const stats = this.playerStats.get(player);
    const old = stats.threeCount;
    stats.threeCount = count;
    stats.lastUpdated = Date.now();
    log.info(`${player}: count manually set ${old} → ${count} (API sync)`);
  }
}

module.exports = DecisionEngine;
