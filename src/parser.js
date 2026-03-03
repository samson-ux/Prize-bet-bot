/**
 * Transcript parser — detects made/missed 3-pointers from voice callouts.
 *
 * DYNAMIC MATCHING: Does NOT require a pre-set player list.
 * Extracts whatever name appears before "for three" and passes it through.
 * Config aliases are used as a bonus normalization layer (e.g., "steph" → "Stephen Curry")
 * but unknown names are passed through as-is for the scraper to match on PrizePicks.
 *
 * CRITICAL: This module must be extremely conservative. A false positive
 * (thinking a 3 was made when it was missed) costs real money. When in
 * doubt, do NOT emit a "made" event.
 *
 * Flow:
 *   1. Detect shot attempt: "[anything] for three / for 3"
 *   2. Extract the name-like words before the trigger
 *   3. Wait for result within a time window
 *   4. Result must be a CONFIRMED "made" phrase — not just absence of "miss"
 *   5. If ambiguous or timed out → skip (do not bet)
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
  'its in', "it's in", 'went in', 'goes in', 'going in',
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
  'bingo',
  'boom',
  'lets go', "let's go",
  'buckets',
  'wet', 'thats wet', "that's wet",
  'clean', 'thats clean', "that's clean",
  'automatic',
  'oh yeah',
];

// NOTE: Removed short/ambiguous single words that could false-positive:
//   'in' (too common), 'nice' (too generic), 'right on' (conversational),
//   'from deep'/'from downtown' (these are shot descriptions, not results)

// ─── MISSED PHRASES ─────────────────────────────────────────────────────────
// Every known way a spotter might indicate a missed 3-pointer.
// If ANY of these appear, we do NOT bet.
const MISSED_PHRASES = [
  // Direct misses
  'no good', 'no good on that',
  'miss', 'missed', 'missed it', 'missed that', 'he missed', 'he missed it',
  'short', 'came up short', 'too short',
  'off the rim', 'off the back', 'off the front', 'off the iron',
  'brick', 'bricked', 'bricked it', 'bricked that',
  'bounced out', 'rimmed out', 'rims out',
  'nah', 'nope', 'nuh uh',
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
  'tough miss',
  'too long',
  'too far left', 'too far right',
  'wide open miss',
  'not this time',
];

// NOTE: Removed short/ambiguous words that could false-positive:
//   'no' (too common in speech), 'off' (too common), 'out' (too common),
//   'tough' (could be "tough shot"), 'long'/'left'/'right'/'wide' (directional),
//   'ugh'/'damn'/'dammit' (emotional, not always about a miss)

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

// ─── NOISE WORDS ────────────────────────────────────────────────────────────
// Words to strip when extracting a player name from text before the trigger.
const NOISE_WORDS = new Set([
  'and', 'the', 'a', 'an', 'he', 'she', 'his', 'her', 'now',
  'then', 'here', 'goes', 'with', 'pulls', 'up', 'shoots',
  'takes', 'fires', 'launches', 'oh', 'wow', 'look', 'at',
  'its', "it's", 'is', 'has', 'got', 'just', 'like', 'so',
  'man', 'dude', 'bro', 'yo', 'hey', 'ok', 'okay', 'um', 'uh',
]);

// ─── PARSER CLASS ───────────────────────────────────────────────────────────

class TranscriptParser extends EventEmitter {
  /**
   * @param {Object} playersConfig - players map from config.json (optional bonus aliases)
   * @param {Object} options
   * @param {number} options.resultWindowMs - how long to wait for result after shot (default 4000ms)
   * @param {number} options.bufferMaxLength - max chars in rolling buffer (default 500)
   */
  constructor(playersConfig = {}, options = {}) {
    super();
    this.resultWindowMs = options.resultWindowMs || 4000;
    this.bufferMaxLength = options.bufferMaxLength || 500;

    // Build optional alias lookup: alias → canonical name
    // This is a BONUS layer — if "steph" is in config, we normalize to "Stephen Curry"
    // But unknown names pass through as-is
    this.playerAliases = new Map();

    for (const [canonical, data] of Object.entries(playersConfig)) {
      this.playerAliases.set(canonical.toLowerCase(), canonical);
      const parts = canonical.toLowerCase().split(' ');
      for (const part of parts) {
        if (part.length > 2) {
          this.playerAliases.set(part, canonical);
        }
      }
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
   * DYNAMIC: extracts whatever name-like words appear before the trigger.
   * No pre-set player list required.
   */
  _checkForShot(text) {
    const searchText = this.buffer.slice(-200); // last ~200 chars

    for (const trigger of THREE_TRIGGERS) {
      const triggerIdx = searchText.lastIndexOf(trigger);
      if (triggerIdx === -1) continue;

      // Extract the text BEFORE the trigger phrase
      const beforeTrigger = searchText.slice(Math.max(0, triggerIdx - 80), triggerIdx).trim();
      const player = this._extractPlayerName(beforeTrigger);

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
   * Extract a player name from the text before the trigger.
   *
   * Strategy:
   *   1. Check config aliases first (e.g., "steph" → "Stephen Curry")
   *   2. If no alias match, extract the last 1-3 capitalized/name-like words
   *      before the trigger and pass them through as the raw name
   *
   * This means ANY player can be detected — no config needed.
   */
  _extractPlayerName(text) {
    if (!text || !text.trim()) return null;

    const cleanText = text.trim();

    // ── Step 1: Check config aliases (bonus normalization) ──

    // Multi-word aliases first
    for (const [alias, canonical] of this.playerAliases) {
      if (alias.includes(' ') && cleanText.includes(alias)) {
        return canonical;
      }
    }

    // Single-word alias check
    const words = cleanText.split(/\s+/);
    for (const word of words) {
      const clean = word.replace(/[^a-z']/g, '');
      if (clean.length < 3) continue;
      if (this.playerAliases.has(clean)) {
        return this.playerAliases.get(clean);
      }
    }

    // Fuzzy alias match (Levenshtein ≤ 2) for words ≥ 4 chars
    for (const word of words) {
      const clean = word.replace(/[^a-z]/g, '');
      if (clean.length < 4) continue;

      let bestMatch = null;
      let bestDist = 3;
      for (const [alias, canonical] of this.playerAliases) {
        if (alias.includes(' ')) continue;
        const d = distance(clean, alias);
        if (d < bestDist) {
          bestDist = d;
          bestMatch = canonical;
        }
      }
      if (bestMatch) {
        log.info(`Fuzzy alias match: "${clean}" → ${bestMatch} (distance: ${bestDist})`);
        return bestMatch;
      }
    }

    // ── Step 2: Dynamic extraction — grab the name-like words ──
    // Take the last 1-3 non-noise words as the player name.
    // This handles cases like "and curry for three" → "curry"
    // or "steph curry for three" → "steph curry" (if not in aliases)

    const nameWords = [];
    // Walk backwards through words, collecting name-like tokens
    for (let i = words.length - 1; i >= 0 && nameWords.length < 3; i--) {
      const w = words[i].replace(/[^a-z']/g, '');
      if (w.length < 2) continue;
      if (NOISE_WORDS.has(w)) {
        // If we already have name words, a noise word means we're past the name
        if (nameWords.length > 0) break;
        continue;
      }
      nameWords.unshift(w);
    }

    if (nameWords.length === 0) return null;

    // Title-case the extracted name for display
    const rawName = nameWords
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    log.info(`Dynamic name extracted: "${rawName}" (no config alias match)`);
    return rawName;
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
}

module.exports = TranscriptParser;
