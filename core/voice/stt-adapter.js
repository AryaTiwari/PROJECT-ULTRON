class SttAdapter {
  constructor(provider = 'external') {
    this.provider = provider;
  }

  async transcribe() {
    throw new Error(`STT provider '${this.provider}' is not configured. The UI or a local adapter must provide audio transcription.`);
  }
}

module.exports = { SttAdapter };
