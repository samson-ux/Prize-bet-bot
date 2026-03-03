/**
 * Transcript parser — detects made/missed 3-pointers from voice callouts.
 *
 * CRITICAL: This module must be extremely conservative. A false positive
 * (thinking a 3 was made when it was missed) costs real money. When in
 * doubt, do NOT emit a "made" event.
 *
 * Flow:
 *   1. Detect shot attempt: "[Player] for three / for 3"
 *   2. Wait for result within a time window
 *   3. Result must be a CONFIRMED "made" phrase — not just absence of "miss"
 *   4. If ambiguous or timed out → skip (do not bet)
 */

const EventEmitter = require('events');
const { distance } = require('fastest-levenshtein');
const createLogger = require('./logger');

const log = createLogger('PARSER');

// ─── MADE PHRASES ───────────────────────────────────────────────────────────
// Every known way a spotter might confirm a made 3-pointer.
// These are checked as substrings against the transcript buffer.
const MADE_PHRASES = [
  // Direct confirmations
  'good', 'its good', "it's good", 'that is good', "that's good",
  'got it', 'he got it', "he's got it",
  'in', 'its in', "it's in", 'went in', 'goes in', 'going in',
  'made it', 'he made it', 'made that', 'he made that',
  'bang', 'bang bang',
  'splash', 'splashed it', 'splashed that',
  'money', 'thats money', "that's money",
  'yes', 'yes sir', 'yessir', 'yep',
  'cash', 'cashed it', 'cashed that',
  'drained it', 'drained that', 'drains it',
  'buried it', 'buried that', 'buries it',
  'nailed it', 'nailed that', 'nails it',
  'hit it', 'hit that', 'hits it', 'hits that',
  'knocked it down', 'knocks it down', 'knocked that down',
  'sinks it', 'sank it', 'sank that',
  'swish', 'nothing but net',
  'count it', 'count that',
  'thats a three', "that's a three", 'thats a 3', "that's a 3",
  'there it is', 'there you go',
  'from deep', 'from downtown',
  'bingo',
  'boom',
  'lets go', "let's go",
  'buckets',
  'wet', 'thats wet', "that's wet",
  'clean', 'thats clean', "that's clean",
  'automatic',
  'right on',
  'oh yeah',
  'nice',
];

// ─── MISSED PHRASES ─────────────────────────────────────────────────────────
// Every known way a spotter might indicate a missed 3-pointer.
// If ANY of these appear, we do NOT bet.
const MISSED_PHRASES = [
  // Direct misses
  'no good', 'no good on that',
  'miss', 'missed', 'missed it', 'missed that', 'he missed', 'he missed it',
  'short', 'came up short', 'too short',
  'off', 'off the rim', 'off the back', 'off the front', 'off the iron',
  'brick', 'bricked', 'bricked it', 'bricked that',
  'out', 'bounced out', 'rimmed out', 'rims out',
  'no', 'nah', 'nope', 'nuh uh',
  'not good', 'not in',
  'didnt go', "didn't go", 'didnt go in', "didn't go in",
  'didnt make', "didn't make", 'didnt make it', "didn't make it",
  'doesnt go', "doesn't go", 'doesnt fall', "doesn't fall",
  'wont go', "won't go", 'wont fall', "won't fall",
  'air ball', 'airball', 'air balled',
  'blocked', 'got blocked', 'swatted',
  'rejected',
  'cant hit', "can't hit",
  'clanked', 'clank',
  'rattled out', 'rattles out',
  'bounces off', 'bounced off',
  'in and out',
  'so close', 'almost', 'just missed',
  'tough', 'tough miss',
  'long', 'too long',
  'left', 'too far left',
  'right', 'too far right',
  'wide', 'wide open miss',
  'not this time',
  'ugh', 'damn', 'dammit',
];

// ─── NEGATION PREFIXES ──────────────────────────────────────────────────────
// If a "made" phrase is preceded by a negation, treat it as a miss.
const NEGATION_PREFIXES = [
  'not', 'no', "didn't", 'didnt', "doesn't", 'doesnt',
  "won't", 'wont', "can't", 'cant', "isn't", 'isnt',
  "wasn't", 'wasnt', 'never', 'barely',
];

// ─── THREE-POINTER TRIGGER PHRASES ─────────────────────────────────────────
const THREE_TRIGGERS = [
  'for three', 'for 3', 'for a three', 'for a 3',
  'three pointer', '3 pointer', 'three point', '3 point',
  'from three', 'from 3', 'from deep', 'from downtown',
  'pulls up for three', 'pulls up for 3',
  'shoots a three', 'shoots a 3', 'shoots the three', 'shoots the 3',
  'takes a three', 'takes a 3', 'takes the three',
  'launches a three', 'launches a 3',
  'fires a three', 'fires a 3',
  'lets it fly', 'lets it go from three',
];

// ─── PARSER CLASS ───────────────────────────────────────────────────────────

class TranscriptParser extends EventEmitter {
  /**
   * @param {Object} playersConfig - players map from config.json
   * @param {Object} options
   * @param {number} options.resultWindowMs - how long to wait for result after shot (default 4000ms)
   * @param {number} options.bufferMaxLength - max chars in rolling buffer (default 500)
   */
  constructor(playersConfig, options = {}) {
    super();
    this.resultWindowMs = options.resultWindowMs || 4000;
    this.bufferMaxLength = options.bufferMaxLength || 500;

    // Build player lookup: alias → canonical name
    this.playerAliases = new Map();
    this.playerNames = [];

    for (const [canonical, data] of Object.entries(playersConfig)) {
      this.playerNames.push(canonical);
      // Add the full name and its parts
      this.playerAliases.set(canonical.toLowerCase(), canonical);
      const parts = canonical.toLowerCase().split(' ');
      for (const part of parts) {
        if (part.length > 2) { // skip short words like "de"
          this.playerAliases.set(part, canonical);
        }
      }
      // Add configured aliases
      if (data.aliases) {
        for (const alias of data.aliases) {
          this.playerAliases.set(alias.toLowerCase(), canonical);
        }
      }
    }

    this.buffer = '';
    this.pendingShot = null; // { player, timestamp, handled }
    this.resultTimer = null;
    this.processedTimestamps = new Set(); // prevent double-processing
  }

  /**
   * Feed transcript text into the parser.
   * Call this every time Deepgram returns text.
   */
  feedTranscript(text) {
    if (!text || !text.trim()) return;

    const cleaned = text.toLowerCase().trim();
    log.info(`"${text.trim()}"`);

    // Append to rolling buffer
    this.buffer += ' ' + cleaned;
    if (this.buffer.length > this.bufferMaxLength) {
      this.buffer = this.buffer.slice(-this.bufferMaxLength);
    }

    // If we have a pending shot, check for result first
    if (this.pendingShot && !this.pendingShot.handled) {
      this._checkResult(cleaned);
      return;
    }

    // Otherwise, look for a new shot attempt
    this._checkForShot(cleaned);
  }

  /**
   * Look for a 3-point shot attempt in the text.
   * Pattern: [something that matches a player] + [three-pointer trigger]
   */
  _checkForShot(text) {
    // Check the buffer for trigger phrases
    const searchText = this.buffer.slice(-200); // last ~200 chars

    for (const trigger of THREE_TRIGGERS) {
      const triggerIdx = searchText.lastIndexOf(trigger);
      if (triggerIdx === -1) continue;

      // Look for a player name in the text BEFORE the trigger
      const beforeTrigger = searchText.slice(Math.max(0, triggerIdx - 80), triggerIdx);
      const player = this._findPlayer(beforeTrigger);

      if (player) {
        const now = Date.now();

        // Prevent duplicate detection within 3 seconds
        const key = `${player}-${Math.floor(now / 3000)}`;
        if (this.processedTimestamps.has(key)) return;
        this.processedTimestamps.add(key);

        // Clean up old timestamps
        if (this.processedTimestamps.size > 50) {
          this.processedTimestamps.clear();
        }

        log.info(`Shot detected: ${player} — waiting for result...`);
        this.pendingShot = { player, timestamp: now, handled: false };

        // Set a timeout — if no clear result, DO NOT BET
        this.resultTimer = setTimeout(() => {
          if (this.pendingShot && !this.pendingShot.handled) {
            log.warn(`Result timeout for ${player} — NO BET (ambiguous)`);
            this.pendingShot.handled = true;
            this.pendingShot = null;
            this.emit('shot', { player, result: 'unknown' });
          }
        }, this.resultWindowMs);

        // Clear the buffer section we already processed
        this.buffer = '';
        return;
      }
    }
  }

  /**
   * Check incoming text for a made/missed result.
   * CRITICAL: We require a POSITIVE made confirmation. Absence of miss is NOT enough.
   */
  _checkResult(text) {
    const searchText = text.toLowerCase();

    // Check for MISSED first — missed takes priority (conservative approach)
    if (this._matchesPhrase(searchText, MISSED_PHRASES)) {
      this._resolveShot('missed');
      return;
    }

    // Check for MADE — but verify no negation precedes it
    const madeMatch = this._matchesPhraseWithNegationCheck(searchText);
    if (madeMatch === 'negated') {
      // A made phrase was found but negated (e.g., "didn't go in") → treat as miss
      this._resolveShot('missed');
      return;
    }
    if (madeMatch === 'confirmed') {
      this._resolveShot('made');
      return;
    }

    // Also check the combined buffer for result
    const recentBuffer = this.buffer.slice(-100).toLowerCase();

    if (this._matchesPhrase(recentBuffer, MISSED_PHRASES)) {
      this._resolveShot('missed');
      return;
    }

    const bufferMadeMatch = this._matchesPhraseWithNegationCheck(recentBuffer);
    if (bufferMadeMatch === 'negated') {
      this._resolveShot('missed');
      return;
    }
    if (bufferMadeMatch === 'confirmed') {
      this._resolveShot('made');
      return;
    }
  }

  /**
   * Check if text contains any phrase from the list.
   */
  _matchesPhrase(text, phrases) {
    for (const phrase of phrases) {
      if (text.includes(phrase)) return true;
    }
    return false;
  }

  /**
   * Check for made phrases, but also check for negation.
   * Returns: 'confirmed' | 'negated' | null
   */
  _matchesPhraseWithNegationCheck(text) {
    for (const phrase of MADE_PHRASES) {
      const idx = text.indexOf(phrase);
      if (idx === -1) continue;

      // Check the 20 chars before the made phrase for negation words
      const beforePhrase = text.slice(Math.max(0, idx - 20), idx).trim();

      let negated = false;
      for (const neg of NEGATION_PREFIXES) {
        if (beforePhrase.endsWith(neg) || beforePhrase.includes(neg + ' ')) {
          negated = true;
          break;
        }
      }

      if (negated) return 'negated';
      return 'confirmed';
    }
    return null;
  }

  /**
   * Resolve a pending shot with a result.
   */
  _resolveShot(result) {
    if (!this.pendingShot || this.pendingShot.handled) return;

    const { player } = this.pendingShot;
    this.pendingShot.handled = true;

    if (this.resultTimer) {
      clearTimeout(this.resultTimer);
      this.resultTimer = null;
    }

    const elapsed = Date.now() - this.pendingShot.timestamp;

    if (result === 'made') {
      log.info(`CONFIRMED MADE: ${player} (${elapsed}ms after shot call)`);
    } else {
      log.info(`Missed/negated: ${player} (${elapsed}ms after shot call)`);
    }

    this.emit('shot', { player, result });
    this.pendingShot = null;
    this.buffer = '';
  }

  /**
   * Find a player name in text using exact alias matching + fuzzy fallback.
   * Returns canonical player name or null.
   */
  _findPlayer(text) {
    const words = text.trim().split(/\s+/);
    if (words.length === 0) return null;

    // 1. Try exact alias matches (most reliable)
    //    Check multi-word aliases first (e.g., "chef curry", "king james")
    for (const [alias, canonical] of this.playerAliases) {
      if (alias.includes(' ') && text.includes(alias)) {
        return canonical;
      }
    }

    // Single-word alias matches
    for (const word of words) {
      const clean = word.replace(/[^a-z]/g, '');
      if (clean.length < 3) continue;
      if (this.playerAliases.has(clean)) {
        return this.playerAliases.get(clean);
      }
    }

    // 2. Fuzzy match as fallback (Levenshtein distance ≤ 2)
    //    Only for words that are at least 4 chars (avoid false positives on short words)
    for (const word of words) {
      const clean = word.replace(/[^a-z]/g, '');
      if (clean.length < 4) continue;

      let bestMatch = null;
      let bestDist = 3; // threshold: must be distance ≤ 2

      for (const [alias, canonical] of this.playerAliases) {
        if (alias.includes(' ')) continue; // skip multi-word for fuzzy
        const d = distance(clean, alias);
        if (d < bestDist) {
          bestDist = d;
          bestMatch = canonical;
        }
      }

      if (bestMatch) {
        log.info(`Fuzzy matched "${clean}" → ${bestMatch} (distance: ${bestDist})`);
        return bestMatch;
      }
    }

    return null;
  }
}

module.exports = TranscriptParser;
