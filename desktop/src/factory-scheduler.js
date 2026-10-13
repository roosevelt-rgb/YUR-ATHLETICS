'use strict';

// Desktop cadence only. Mission authority, locking, validation and persistence
// remain in the existing factory runtime called by process().
class FactoryScheduler {
  constructor({ process, onState = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    this.process = process;
    this.onState = onState;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.timer = null;
    this.inFlight = Promise.resolve();
    this.state = { enabled: false, running: false, cycles: 0, max_cycles: 0, interval_seconds: 30, next_cycle_at: null, last_result: null, error: null };
  }

  status() { return JSON.parse(JSON.stringify(this.state)); }

  publish() { this.onState(this.status()); }

  start({ max_cycles, interval_seconds }) {
    if (this.state.enabled || this.state.running) throw new Error('Continuous processing is already active or finishing a cycle.');
    if (!Number.isInteger(max_cycles) || max_cycles < 1 || max_cycles > 100 || !Number.isInteger(interval_seconds) || interval_seconds < 5 || interval_seconds > 3600) throw new Error('Set 1–100 cycles and an interval of 5–3600 seconds.');
    this.state = { enabled: true, running: false, cycles: 0, max_cycles, interval_seconds, next_cycle_at: null, last_result: null, error: null };
    this.runCycle();
    return this.status();
  }

  stop() {
    this.state.enabled = false;
    this.state.next_cycle_at = null;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    this.publish();
    return this.status();
  }

  runCycle() {
    this.timer = null;
    if (!this.state.enabled || this.state.running) return;
    this.state.running = true;
    this.state.next_cycle_at = null;
    this.publish();
    this.inFlight = (async () => {
      try {
        const response = await this.process({ command: 'process', max_missions: 1 });
        this.state.cycles += 1;
        if (!response || response.ok !== true) {
          this.state.error = response?.error || { code: 'INVALID_RESPONSE', message: 'Factory returned no cycle result.' };
          this.state.enabled = false;
        } else this.state.last_result = response.result;
      } catch (error) {
        this.state.cycles += 1;
        this.state.error = { code: 'CYCLE_FAILED', message: String(error?.message || error) };
        this.state.enabled = false;
      } finally {
        this.state.running = false;
        if (this.state.cycles >= this.state.max_cycles) this.state.enabled = false;
        if (this.state.enabled) {
          this.state.next_cycle_at = new Date(this.now() + this.state.interval_seconds * 1000).toISOString();
          this.timer = this.setTimer(() => this.runCycle(), this.state.interval_seconds * 1000);
        }
        this.publish();
      }
    })();
  }
}

module.exports = { FactoryScheduler };
