/**
 * Deepgram streaming transcription via WebSocket.
 *
 * - Opens persistent WebSocket to Deepgram
 * - Accepts raw PCM 16kHz mono 16-bit audio chunks
 * - Emits transcript text events as fast as possible
 * - Handles reconnection on disconnect
 */

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { EventEmitter } = require('events');
const createLogger = require('./logger');

const log = createLogger('DEEPGRAM');

class Transcriber extends EventEmitter {
  constructor(config) {
    super();
    this.apiKey = config.deepgram.apiKey;
    this.deepgram = createClient(this.apiKey);
    this.connection = null;
    this.isConnected = false;
    this.reconnecting = false;
  }

  async start() {
    await this._connect();
  }

  async _connect() {
    log.info('Opening Deepgram WebSocket...');

    this.connection = this.deepgram.listen.live({
      model: 'nova-2',
      language: 'en',
      smart_format: false,
      punctuate: false,
      interim_results: true,
      endpointing: 300,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
    });

    this.connection.on(LiveTranscriptionEvents.Open, () => {
      log.info('WebSocket connected');
      this.isConnected = true;
      this.reconnecting = false;
    });

    this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (transcript && transcript.trim()) {
        const isFinal = data.is_final;
        this.emit('transcript', {
          text: transcript,
          isFinal,
        });
      }
    });

    this.connection.on(LiveTranscriptionEvents.Close, () => {
      log.warn('WebSocket closed');
      this.isConnected = false;
      this._reconnect();
    });

    this.connection.on(LiveTranscriptionEvents.Error, (err) => {
      log.error(`WebSocket error: ${err.message || err}`);
      this.isConnected = false;
      this._reconnect();
    });
  }

  /**
   * Send raw audio data to Deepgram.
   * Call this with PCM 16kHz mono 16-bit buffers.
   */
  sendAudio(audioBuffer) {
    if (this.isConnected && this.connection) {
      this.connection.send(audioBuffer);
    }
  }

  async _reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    log.info('Reconnecting in 2 seconds...');
    await new Promise((r) => setTimeout(r, 2000));
    await this._connect();
  }

  close() {
    if (this.connection) {
      this.connection.finish();
      this.isConnected = false;
      log.info('Deepgram connection closed');
    }
  }
}

module.exports = Transcriber;
