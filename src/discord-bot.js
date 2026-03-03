/**
 * Discord voice channel audio capture.
 *
 * - Connects to a Discord server
 * - Lists voice channels and lets the user pick one at startup
 * - Captures audio from all users in the channel
 * - Converts PCM 48kHz stereo → 16kHz mono 16-bit for Deepgram
 * - Emits audio chunks via EventEmitter
 */

const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { EventEmitter } = require('events');
const readline = require('readline');
const createLogger = require('./logger');

const log = createLogger('AUDIO');

class DiscordAudioCapture extends EventEmitter {
  constructor(config) {
    super();
    this.token = config.discord.token;
    this.guildId = config.discord.guildId;
    this.client = null;
    this.connection = null;
    this.subscribedUsers = new Set();
  }

  async connect() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
      ],
    });

    await this.client.login(this.token);
    log.info('Discord bot logged in');

    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) {
      await this.client.guilds.fetch(this.guildId);
    }
    const fetchedGuild = this.client.guilds.cache.get(this.guildId);
    if (!fetchedGuild) {
      throw new Error(`Guild ${this.guildId} not found. Check your guildId in config.json`);
    }

    // Fetch all channels and filter to voice channels
    await fetchedGuild.channels.fetch();
    const voiceChannels = fetchedGuild.channels.cache.filter(
      (ch) => ch.type === 2 // GuildVoice
    );

    if (voiceChannels.size === 0) {
      throw new Error('No voice channels found in this server');
    }

    // Let user pick the voice channel
    const channelId = await this._pickChannel(voiceChannels);
    const channel = voiceChannels.get(channelId);
    log.info(`Joining voice channel: ${channel.name}`);

    // Join the voice channel
    this.connection = joinVoiceChannel({
      channelId: channelId,
      guildId: this.guildId,
      adapterCreator: fetchedGuild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    // Wait for connection to be ready
    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    log.info('Connected to Discord voice channel');

    // Listen for users speaking
    const receiver = this.connection.receiver;

    receiver.speaking.on('start', (userId) => {
      if (this.subscribedUsers.has(userId)) return;
      this.subscribedUsers.add(userId);

      log.info(`User ${userId} started speaking — subscribing to audio`);

      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
      });

      // Decode Opus → PCM 48kHz stereo
      const decoder = new prism.opus.Decoder({
        frameSize: 960,
        channels: 2,
        rate: 48000,
      });

      opusStream.pipe(decoder);

      // Collect PCM data and downsample
      decoder.on('data', (chunk) => {
        const mono16k = this._downsample(chunk, 48000, 16000, 2);
        this.emit('audio', mono16k);
      });

      opusStream.on('end', () => {
        this.subscribedUsers.delete(userId);
        log.info(`User ${userId} stopped speaking`);
      });

      opusStream.on('error', (err) => {
        log.error(`Opus stream error for ${userId}: ${err.message}`);
        this.subscribedUsers.delete(userId);
      });

      decoder.on('error', (err) => {
        log.error(`Decoder error for ${userId}: ${err.message}`);
      });
    });

    // Handle disconnections
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      log.warn('Disconnected from voice channel — attempting to reconnect...');
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Seems to be reconnecting
      } catch {
        // Reconnect failed — destroy and re-join
        log.error('Reconnection failed — connection destroyed');
        this.connection.destroy();
        this.subscribedUsers.clear();
      }
    });
  }

  /**
   * Downsample PCM: stereo 48kHz 16-bit → mono 16kHz 16-bit
   */
  _downsample(buffer, fromRate, toRate, channels) {
    const ratio = fromRate / toRate;
    const srcSamples = buffer.length / (2 * channels); // 2 bytes per sample
    const dstSamples = Math.floor(srcSamples / ratio);
    const out = Buffer.alloc(dstSamples * 2); // mono 16-bit

    for (let i = 0; i < dstSamples; i++) {
      const srcIdx = Math.floor(i * ratio);
      const byteOffset = srcIdx * 2 * channels;
      if (byteOffset + 1 >= buffer.length) break;

      // Average stereo channels for mono
      if (channels === 2 && byteOffset + 3 < buffer.length) {
        const left = buffer.readInt16LE(byteOffset);
        const right = buffer.readInt16LE(byteOffset + 2);
        out.writeInt16LE(Math.round((left + right) / 2), i * 2);
      } else {
        out.writeInt16LE(buffer.readInt16LE(byteOffset), i * 2);
      }
    }

    return out;
  }

  /**
   * Present a terminal menu for the user to pick a voice channel.
   */
  _pickChannel(voiceChannels) {
    return new Promise((resolve) => {
      const channels = [...voiceChannels.values()];
      console.log('\n╔══════════════════════════════════════════╗');
      console.log('║       SELECT DISCORD VOICE CHANNEL       ║');
      console.log('╠══════════════════════════════════════════╣');
      channels.forEach((ch, idx) => {
        const members = ch.members.size;
        const memberStr = members > 0 ? ` (${members} user${members > 1 ? 's' : ''})` : ' (empty)';
        const line = `  ${idx + 1}. ${ch.name}${memberStr}`;
        console.log(`║${line.padEnd(42)}║`);
      });
      console.log('╚══════════════════════════════════════════╝');

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('Select channel (number): ', (answer) => {
        rl.close();
        const idx = parseInt(answer, 10) - 1;
        if (idx >= 0 && idx < channels.length) {
          resolve(channels[idx].id);
        } else {
          log.warn('Invalid selection, using first channel');
          resolve(channels[0].id);
        }
      });
    });
  }

  disconnect() {
    if (this.connection) {
      this.connection.destroy();
      log.info('Disconnected from voice channel');
    }
    if (this.client) {
      this.client.destroy();
      log.info('Discord client destroyed');
    }
  }
}

module.exports = DiscordAudioCapture;
