/**
 * Courtsiding Bot — Entry Point
 *
 * Flow:
 *   1. Launch Playwright browser → user logs in to PrizePicks
 *   2. Scrape tomorrow's props → present 3 options → user picks + bet size
 *   3. Place first leg automatically
 *   4. Connect to Discord voice channel (user picks which one)
 *   5. Start Deepgram transcription stream
 *   6. Wire: audio → transcriber → parser → engine → scraper/betplacer
 *   7. Listen until bet is placed or user stops
 */

const config = require('./config.json');
const createLogger = require('./src/logger');
const BetPlacer = require('./src/betplacer');
const { PrizePicksScraper } = require('./src/scraper');
const { runFirstLegPicker } = require('./src/first-leg-picker');
const DiscordAudioCapture = require('./src/discord-bot');
const Transcriber = require('./src/transcriber');
const TranscriptParser = require('./src/parser');
const DecisionEngine = require('./src/engine');

const log = createLogger('SETUP');

async function main() {
  log.info('=== Courtsiding Bot Starting ===');

  // ─── PHASE 1: Browser + Login ─────────────────────────────────────────────

  const betPlacer = new BetPlacer(config);
  const page = await betPlacer.launchBrowser();
  log.info('Playwright browser launched');

  await betPlacer.waitForLogin();
  log.info('User logged in. Starting first leg picker...');

  // ─── PHASE 2: First Leg Selection ─────────────────────────────────────────

  const scraper = new PrizePicksScraper(page);
  const result = await runFirstLegPicker(scraper, betPlacer, config.betting);

  if (result) {
    log.info(`First leg locked in: ${result.selection.player} Over ${result.selection.line} ${result.selection.stat}, $${result.betSize}`);
  } else {
    log.info('First leg entered manually. Continuing...');
  }

  // Navigate to the live board for second leg monitoring
  log.info('Navigating to live board...');
  await page.goto('https://app.prizepicks.com/board', {
    waitUntil: 'networkidle',
    timeout: 15000,
  });

  // Start periodic refresh of the live board
  scraper.startPeriodicRefresh(150000); // every 2.5 minutes

  // ─── PHASE 3: Discord + Audio Pipeline ────────────────────────────────────

  log.info('Connecting to Discord voice channel...');
  const discord = new DiscordAudioCapture(config);
  await discord.connect();

  log.info('Starting Deepgram transcription...');
  const transcriber = new Transcriber(config);
  await transcriber.start();

  const parser = new TranscriptParser(config.players);
  const engine = new DecisionEngine(scraper, betPlacer);

  // ─── WIRE THE PIPELINE ────────────────────────────────────────────────────

  // Discord audio → Deepgram
  discord.on('audio', (audioBuffer) => {
    transcriber.sendAudio(audioBuffer);
  });

  // Deepgram transcript → Parser
  transcriber.on('transcript', ({ text, isFinal }) => {
    parser.feedTranscript(text);
  });

  // Parser shot events → Engine
  parser.on('shot', (event) => {
    engine.handleShot(event);
  });

  // Start idle mouse movements to look human during inactive periods
  betPlacer.startIdleMovement();

  log.info('');
  log.info('════════════════════════════════════════════════');
  log.info('  Pipeline active! Listening for 3-pointers...');
  log.info('  Idle mouse movement active in browser.');
  log.info('  Press Ctrl+C to stop.');
  log.info('════════════════════════════════════════════════');
  log.info('');

  // ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────

  process.on('SIGINT', async () => {
    log.info('');
    log.info('Shutting down...');

    scraper.stopPeriodicRefresh();
    discord.disconnect();
    transcriber.close();
    await betPlacer.close();

    // Print final stats
    const stats = engine.getStats();
    if (Object.keys(stats).length > 0) {
      log.info('');
      log.info('=== Final Player Stats ===');
      for (const [player, data] of Object.entries(stats)) {
        const betStr = data.betPlaced ? ' [BET PLACED]' : '';
        log.info(`  ${player}: ${data.threeCount} three-pointers${betStr}`);
      }
    }

    log.info('=== Courtsiding Bot Stopped ===');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
