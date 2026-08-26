const STATES = Object.freeze(['idle', 'listening', 'thinking', 'speaking', 'error']);

class VoiceState {
  constructor() {
    this.state = 'idle';
    this.updatedAt = new Date().toISOString();
    this.error = null;
  }

  set(state, error = null) {
    if (!STATES.includes(state)) throw new Error(`Invalid voice state: ${state}`);
    this.state = state;
    this.error = error ? String(error) : null;
    this.updatedAt = new Date().toISOString();
    return this.snapshot();
  }

  snapshot() {
    return { state: this.state, updatedAt: this.updatedAt, error: this.error };
  }
}

module.exports = { STATES, VoiceState };
