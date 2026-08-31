const { VoiceState } = require('./voice-state');
const wakeWord = require('./wake-word');
const { synthesize } = require('./local-tts');
const { playLocalAudio } = require('./playback');

class VoicePipeline {
  constructor({ transcribe } = {}) {
    this.state = new VoiceState();
    this.transcribe = typeof transcribe === 'function' ? transcribe : null;
    this.armedUntil = 0;
    this.followUpWindowMs = Number(process.env.ULTRON_WAKE_FOLLOWUP_MS || 8000);
  }

  snapshot() {
    return { ...this.state.snapshot(), armed: this.isArmed(), armedUntil: this.armedUntil || null };
  }

  isArmed() {
    return Date.now() < this.armedUntil;
  }

  arm() {
    this.armedUntil = Date.now() + this.followUpWindowMs;
  }

  disarm() {
    this.armedUntil = 0;
  }

  detectWakeWord(text) {
    return wakeWord.detect(String(text || ''));
  }

  async speakAndPlay(text) {
    const audio = await synthesize(text);
    if (audio?.path && process.env.ULTRON_VOICE_AUTOPLAY !== 'false') {
      await playLocalAudio(audio.path);
    }
    return audio;
  }

  async processTranscript(transcript, handleMessage) {
    const text = String(transcript || '').trim();
    if (!text) return { activated: false, state: this.snapshot() };

    const wakeDetected = this.detectWakeWord(text);
    let command = '';

    if (wakeDetected) {
      command = wakeWord.extractCommand(text);

      if (!command) {
        this.arm();
        this.state.set('listening');

        if (process.env.ULTRON_VOICE_ACK !== 'false' && process.env.ULTRON_VOICE_AUTOPLAY !== 'false') {
          try {
            await this.speakAndPlay('Yes?');
          } catch (error) {
            this.state.set('error', error.message);
            return { activated: true, command: '', error: error.message, state: this.snapshot() };
          }
        }

        return {
          activated: true,
          wakeWordOnly: true,
          command: '',
          state: this.snapshot(),
        };
      }

      this.disarm();
    } else if (this.isArmed()) {
      command = text;
      this.disarm();
    } else {
      return { activated: false, state: this.snapshot() };
    }

    this.state.set('thinking');
    try {
      const result = await handleMessage(command);
      if (!result?.ok) {
        this.state.set('error', result?.error || 'ULTRON Core returned an error.');
        return { activated: true, command, result, state: this.snapshot() };
      }

      if (result.response && process.env.ULTRON_VOICE_AUTOPLAY !== 'false' && !/^(?:ultron\s+)?(?:speak|say)\s*:/i.test(command)) {
        this.state.set('speaking');
        try {
          const audio = await synthesize(result.response);
          let playback = null;
          if (audio?.path) playback = await playLocalAudio(audio.path);
          this.state.set('idle');
          return { activated: true, command, result, audio, playback, state: this.snapshot() };
        } catch (error) {
          this.state.set('error', error.message);
          return { activated: true, command, result, error: error.message, state: this.snapshot() };
        }
      }

      this.state.set('idle');
      return { activated: true, command, result, state: this.snapshot() };
    } catch (error) {
      this.state.set('error', error.message);
      return { activated: true, command, error: error.message, state: this.snapshot() };
    }
  }

  async transcribeAudio(audioBuffer, mimeType) {
    if (!this.transcribe) throw new Error('No STT adapter configured.');
    this.state.set('listening');
    try {
      const transcript = await this.transcribe(audioBuffer, mimeType);
      return { transcript, state: this.snapshot() };
    } catch (error) {
      this.state.set('error', error.message);
      throw error;
    }
  }
}

module.exports = { VoicePipeline };
