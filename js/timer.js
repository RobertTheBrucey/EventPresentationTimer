import { getState, dispatch } from './state.js';

let _tickInterval = null;

/**
 * Start the local tick loop. Safe to call multiple times.
 */
export function startTick() {
  if (_tickInterval) return;
  _tickInterval = setInterval(_tick, 100);
}

/**
 * Stop the local tick loop.
 */
export function stopTick() {
  clearInterval(_tickInterval);
  _tickInterval = null;
}

function _tick() {
  const s = getState();
  if (s.timerState !== 'running' && s.timerState !== 'overtime') return;
  dispatch({ type: 'TICK' });
}

/**
 * Compute the current timer values from state without mutating anything.
 * @param {object} state
 * @returns {{ remainingMs: number, elapsedMs: number, overtimeMs: number, durationMs: number }}
 */
export function computeTimerValues(state) {
  const slot = state.slots[state.currentSlotIndex];
  if (!slot) return { remainingMs: 0, elapsedMs: 0, overtimeMs: 0, durationMs: 0 };

  const durationMs = slot.durationSec * 1000;
  let elapsedMs = state.slotElapsedMs;

  if ((state.timerState === 'running' || state.timerState === 'overtime') && state.slotStartedAt !== null) {
    elapsedMs += performance.now() - state.slotStartedAt;
  }

  const remainingMs = durationMs - elapsedMs;
  const overtimeMs = remainingMs < 0 ? Math.abs(remainingMs) : 0;

  return { remainingMs, elapsedMs, overtimeMs, durationMs };
}

/**
 * Compute planned end time (Date) based on current slot + wall clock.
 * @param {object} state
 * @returns {Date|null}
 */
export function computePlannedEnd(state) {
  const { remainingMs } = computeTimerValues(state);
  if (remainingMs <= 0) return null;
  return new Date(Date.now() + remainingMs);
}

/**
 * Determine traffic light colour based on remaining time and thresholds.
 * @param {number} remainingMs
 * @param {{ yellowAt: number, redAt: number }} thresholds
 * @param {'idle'|'running'|'paused'|'overtime'|'stopped'} timerState
 * @returns {'green'|'yellow'|'red'|'overtime'|'idle'}
 */
export function trafficLight(remainingMs, thresholds, timerState) {
  if (timerState === 'idle' || timerState === 'stopped') return 'idle';
  if (timerState === 'overtime') return 'overtime';
  const remainingSec = remainingMs / 1000;
  if (remainingSec <= thresholds.redAt) return 'red';
  if (remainingSec <= thresholds.yellowAt) return 'yellow';
  return 'green';
}

/**
 * Build the SYNC payload (safe to send to display — no operatorNotes).
 * @param {object} state
 * @returns {object}
 */
export function buildSyncPayload(state) {
  return {
    timerState: state.timerState,
    currentSlotIndex: state.currentSlotIndex,
    slotElapsedMs: state.slotElapsedMs + (
      (state.timerState === 'running' || state.timerState === 'overtime') && state.slotStartedAt
        ? performance.now() - state.slotStartedAt
        : 0
    ),
    slots: state.slots.map(({ id, name, title, durationSec }) => ({ id, name, title, durationSec })),
    thresholds: state.thresholds,
    customMessage: state.customMessage,
    sessionStartWallClock: state.sessionStartWallClock,
    serverWallClock: Date.now(),
  };
}
