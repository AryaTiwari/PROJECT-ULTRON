const { VoiceState } = require('./voice-state');
const wakeWord = require('./wake-word');
const { synthesize } = require('./local-tts');

class VoicePipeline {
  constructor({ transcribe } = {}) {
    this.state = new VoiceState();
    this.transcribe = typeof transcribe === 'function' ? transcribe : null;
  }

  snapshot() {
    return this.state.snapshot();
  }

  detectWakeWord(text) {
    return wakeWord.detect(String(text || ''));
  }

  async processTranscript(transcript, handleMessage) {
    const text = String(transcript || '').trim();
    if (!this.detectWakeWord(text)) {
      return { activated: false, state: this.state.snapshot() };
    }

    const command = wakeWord.extractCommand(text);
    if (!command) {
      return { activated: true, command: '', state: this.state.set('listening') };
    }

    this.state.set('thinking');
    try {
      const result = await handleMessage(command);
      if (!result?.ok) {
        this.state.set('error', result?.error || 'ULTRON Core returned an error.');
        return { activated: true, command, result, state: this.state.snapshot() };
      }

      if (result.response && process.env.ULTRON_VOICE_AUTOPLAY !== 'false') {
        this.state.set('speaking');
        try {
          const audio = await synthesize(result.response);
          this.state.set('idle');
          return { activated: true, command, result, audio, state: this.state.snapshot() };
        } catch (error) {
          this.state.set('error', error.message);
          return { activated: true, command, result, error: error.message, state: this.state.snapshot() };
        }
      }

      this.state.set('idle');
      return { activated: true, command, result, state: this.state.snapshot() };
    } catch (error) {
      this.state.set('error', error.message);
      return { activated: true, command, error: error.message, state: this.state.snapshot() };
    }
  }

  async transcribeAudio(audioBuffer, mimeType) {
    if (!this.transcribe) throw new Error('No STT adapter configured.');
    this.state.set('listening');
    try {
      const transcript = await this.transcribe(audioBuffer, mimeType);
      return { transcript, state: this.state.snapshot() };
    } catch (error) {
      this.state.set('error', error.message);
      throw error;
    }
  }
}

module.exports = { VoicePipeline };
