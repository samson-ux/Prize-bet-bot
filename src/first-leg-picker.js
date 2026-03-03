/**
 * First Leg Picker — pre-game prop selection.
 *
 * Scrapes PrizePicks for tomorrow's props across all sports (3:30-9:00 PM ET),
 * filters out goblin/demon, presents 3 options in terminal, user picks one + bet size.
 */

const readline = require('readline');
const createLogger = require('./logger');

const log = createLogger('FIRST-LEG');

/**
 * Select 3 diverse options from clean props.
 * Prefers: different sports/games, lower lines (safer throwaway picks).
 */
function pickThreeOptions(props) {
  if (props.length <= 3) return props;

  // Group by sport
  const bySport = {};
  for (const p of props) {
    const key = p.sport || 'Unknown';
    if (!bySport[key]) bySport[key] = [];
    bySport[key].push(p);
  }

  const sports = Object.keys(bySport);
  const selected = [];

  // Try to pick one from each different sport
  for (const sport of sports) {
    if (selected.length >= 3) break;
    // Sort by line ascending (lower = safer for throwaway)
    const sorted = bySport[sport].sort((a, b) => a.line - b.line);
    // Pick the lowest line that isn't a duplicate player
    for (const prop of sorted) {
      if (!selected.find((s) => s.player === prop.player)) {
        selected.push(prop);
        break;
      }
    }
  }

  // If we still need more, fill from remaining
  if (selected.length < 3) {
    const allSorted = props.sort((a, b) => a.line - b.line);
    for (const prop of allSorted) {
      if (selected.length >= 3) break;
      if (!selected.find((s) => s.player === prop.player)) {
        selected.push(prop);
      }
    }
  }

  return selected.slice(0, 3);
}

/**
 * Display options and get user selection + bet size.
 */
function promptUser(options, bettingConfig) {
  return new Promise((resolve) => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║   FIRST LEG OPTIONS — Tomorrow\'s Games (3:30-9:00 PM ET)    ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');

    options.forEach((opt, idx) => {
      const sportTag = `[${opt.sport}]`.padEnd(8);
      const line1 = `  ${idx + 1}. ${opt.player} — Over ${opt.line} ${opt.stat}`;
      const line2 = `     ${opt.matchup} — ${opt.gameTime}`;
      console.log(`║${(line1 + '  ' + sportTag).padEnd(62)}║`);
      console.log(`║${line2.padEnd(62)}║`);
      if (idx < options.length - 1) {
        console.log(`║${''.padEnd(62)}║`);
      }
    });

    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  Select option (1/2/3):                                     ║');
    console.log('║  Enter bet size ($):                                        ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question('\nSelect option (1/2/3): ', (choiceStr) => {
      const choice = parseInt(choiceStr, 10);
      if (choice < 1 || choice > options.length || isNaN(choice)) {
        log.warn('Invalid selection, defaulting to option 1');
      }
      const selected = options[Math.max(0, Math.min(options.length - 1, (choice || 1) - 1))];

      rl.question(`Enter bet size ($) [default: ${bettingConfig.defaultBetSize}]: `, (sizeStr) => {
        rl.close();

        let betSize = parseInt(sizeStr, 10);
        if (isNaN(betSize) || betSize <= 0) {
          betSize = bettingConfig.defaultBetSize;
        }
        betSize = Math.max(bettingConfig.minBetSize, Math.min(bettingConfig.maxBetSize, betSize));

        log.info(`User selected: ${selected.player} Over ${selected.line} ${selected.stat} [${selected.sport}], bet size: $${betSize}`);
        resolve({ selection: selected, betSize });
      });
    });
  });
}

/**
 * Run the full first-leg picker flow.
 * @param {PrizePicksScraper} scraper
 * @param {BetPlacer} betPlacer
 * @param {Object} bettingConfig - config.betting
 * @returns {{ selection, betSize }}
 */
async function runFirstLegPicker(scraper, betPlacer, bettingConfig) {
  // Step 1: Scrape tomorrow's props
  log.info('Scraping tomorrow\'s props...');
  const allProps = await scraper.scrapeTomorrowProps('15:30', '21:00');

  if (allProps.length === 0) {
    log.error('No clean props found for tomorrow. You may need to update selectors.');
    log.info('Falling back to manual mode — please enter first leg manually in the browser.');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => {
      rl.question('Press Enter after you\'ve manually entered the first leg... ', () => {
        rl.close();
        resolve();
      });
    });

    return null;
  }

  // Step 2: Pick 3 options
  log.info(`Found ${allProps.length} clean props. Selecting 3 options...`);
  const options = pickThreeOptions(allProps);

  // Step 3: Present to user
  const { selection, betSize } = await promptUser(options, bettingConfig);

  // Step 4: Place the first leg via Playwright
  log.info('Placing first leg...');
  const success = await betPlacer.placeFirstLeg(selection, betSize);

  if (success) {
    log.info('First leg entered. Slip ready.');
  } else {
    log.error('Failed to auto-place first leg. Please enter it manually in the browser.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => {
      rl.question('Press Enter after you\'ve manually entered the first leg... ', () => {
        rl.close();
        resolve();
      });
    });
  }

  return { selection, betSize };
}

module.exports = { runFirstLegPicker };
