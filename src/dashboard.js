/**
 * Web dashboard — Express server with SSE for real-time updates.
 * Serves a single-page dark theme UI at http://localhost:3000
 */

const express = require('express');
const path = require('path');
const createLogger = require('./logger');
const { logBus } = createLogger;

const log = createLogger('DASHBOARD');

const app = express();
const PORT = 3000;

// SSE clients
const clients = new Set();

// Module references (set via init())
let engine = null;
let parser = null;
let transcriber = null;

// Serve static files from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// SSE endpoint — browser connects here for live updates
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial connected event
  sendToClient(res, 'status', { type: 'connected', time: Date.now() });

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// REST endpoint for current stats
app.get('/api/stats', (req, res) => {
  if (engine) {
    res.json(engine.getStats());
  } else {
    res.json({});
  }
});

/** Send an SSE event to one client */
function sendToClient(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Broadcast an SSE event to all connected clients */
function broadcast(event, data) {
  for (const client of clients) {
    sendToClient(client, event, data);
  }
}

/**
 * Initialize the dashboard with references to live modules.
 * Call this after all modules are wired up.
 */
function init(modules) {
  engine = modules.engine || null;
  parser = modules.parser || null;
  transcriber = modules.transcriber || null;

  // Forward all log lines to SSE clients
  logBus.on('log', (data) => {
    broadcast('log', data);
  });

  // Forward transcript events
  if (transcriber) {
    transcriber.on('transcript', ({ text, isFinal }) => {
      broadcast('transcript', { text, isFinal, time: Date.now() });
    });
  }

  // Forward shot detection events
  if (parser) {
    parser.on('shot', (event) => {
      broadcast('shot', { ...event, time: Date.now() });

      // Also broadcast updated stats after each shot
      if (engine) {
        broadcast('stats', engine.getStats());
      }
    });
  }
}

/** Start the Express server */
function start() {
  app.listen(PORT, () => {
    log.info(`Dashboard running at http://localhost:${PORT}`);
  });
}

module.exports = { init, start };
