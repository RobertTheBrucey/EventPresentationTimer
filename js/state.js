import { uuid } from './utils.js';

/** @typedef {'idle'|'running'|'paused'|'overtime'|'stopped'} TimerState */

/** @type {AppState} */
const initialState = {
  timerState: 'idle',
  currentSlotIndex: 0,
  slotStartedAt: null,
  slotElapsedMs: 0,
  slots: [],
  thresholds: { yellowAt: 300, redAt: 60 },
  customMessage: '',
  sessionStartWallClock: null,
  theme: localStorage.getItem('ept-theme') || 'dark',
  role: new URLSearchParams(location.search).get('role') || 'controller',
  peerId: sessionStorage.getItem('ept-peer-id') || (() => {
    const id = uuid();
    sessionStorage.setItem('ept-peer-id', id);
    return id;
  })(),
  sessionCode: null,
  connectedPeers: [],
};

let _state = { ...initialState };

const BUS = new EventTarget();

export function getState() {
  return _state;
}

/**
 * Dispatch an action to update state. Emits a 'statechange' event.
 * @param {{ type: string, [key: string]: any }} action
 */
export function dispatch(action) {
  const prev = _state;
  _state = reducer(_state, action);
  if (_state !== prev) {
    BUS.dispatchEvent(Object.assign(new Event('statechange'), { state: _state, action }));
  }
}

/**
 * Subscribe to state changes.
 * @param {(state: AppState, action: object) => void} handler
 * @returns {() => void} unsubscribe function
 */
export function subscribe(handler) {
  const listener = e => handler(e.state, e.action);
  BUS.addEventListener('statechange', listener);
  return () => BUS.removeEventListener('statechange', listener);
}

function reducer(state, action) {
  switch (action.type) {

    // ── Timer ──────────────────────────────────────────────────────────────
    case 'TIMER_START': {
      if (state.timerState !== 'idle' && state.timerState !== 'stopped') return state;
      return {
        ...state,
        timerState: 'running',
        slotStartedAt: performance.now(),
        slotElapsedMs: 0,
        sessionStartWallClock: state.sessionStartWallClock ?? Date.now(),
      };
    }

    case 'TIMER_RESUME': {
      if (state.timerState !== 'paused') return state;
      const slot = state.slots[state.currentSlotIndex];
      const remainingMs = slot ? (slot.durationSec * 1000) - state.slotElapsedMs : 0;
      return {
        ...state,
        timerState: remainingMs <= 0 ? 'overtime' : 'running',
        slotStartedAt: performance.now(),
      };
    }

    case 'TIMER_PAUSE': {
      if (state.timerState !== 'running' && state.timerState !== 'overtime') return state;
      return {
        ...state,
        timerState: 'paused',
        slotElapsedMs: state.slotElapsedMs + (performance.now() - state.slotStartedAt),
        slotStartedAt: null,
      };
    }

    case 'TIMER_STOP': {
      return {
        ...state,
        timerState: 'stopped',
        slotStartedAt: null,
      };
    }

    case 'TIMER_RESET': {
      return {
        ...state,
        timerState: 'idle',
        slotStartedAt: null,
        slotElapsedMs: 0,
      };
    }

    case 'TICK': {
      if (state.timerState === 'running' || state.timerState === 'overtime') {
        const elapsed = state.slotElapsedMs + (performance.now() - state.slotStartedAt);
        const slot = state.slots[state.currentSlotIndex];
        const remaining = slot ? (slot.durationSec * 1000) - elapsed : 0;
        const nextTimerState = remaining <= 0 ? 'overtime' : 'running';
        return { ...state, timerState: nextTimerState };
      }
      return state;
    }

    case 'SLOT_ADVANCE': {
      const toIndex = action.toIndex ?? state.currentSlotIndex + 1;
      if (toIndex >= state.slots.length) return state;
      return {
        ...state,
        currentSlotIndex: toIndex,
        timerState: 'idle',
        slotStartedAt: null,
        slotElapsedMs: 0,
      };
    }

    // ── Schedule ───────────────────────────────────────────────────────────
    case 'SCHEDULE_SET': {
      return { ...state, slots: action.slots };
    }

    case 'SLOT_ADD': {
      return { ...state, slots: [...state.slots, { ...action.slot, id: action.slot.id ?? uuid() }] };
    }

    case 'SLOT_UPDATE': {
      return {
        ...state,
        slots: state.slots.map(s => s.id === action.slot.id ? { ...s, ...action.slot } : s),
      };
    }

    case 'SLOT_DELETE': {
      const filtered = state.slots.filter(s => s.id !== action.id);
      return {
        ...state,
        slots: filtered,
        currentSlotIndex: Math.min(state.currentSlotIndex, Math.max(0, filtered.length - 1)),
      };
    }

    case 'SLOT_REORDER': {
      const slots = [...state.slots];
      const [moved] = slots.splice(action.from, 1);
      slots.splice(action.to, 0, moved);
      return { ...state, slots };
    }

    // ── Config ─────────────────────────────────────────────────────────────
    case 'THRESHOLDS_SET': {
      return { ...state, thresholds: { ...state.thresholds, ...action.thresholds } };
    }

    case 'MESSAGE_SET': {
      return { ...state, customMessage: action.message };
    }

    case 'MESSAGE_CLEAR': {
      return { ...state, customMessage: '' };
    }

    case 'THEME_SET': {
      localStorage.setItem('ept-theme', action.theme);
      return { ...state, theme: action.theme };
    }

    // ── Peers ──────────────────────────────────────────────────────────────
    case 'SESSION_CODE_SET': {
      return { ...state, sessionCode: action.code };
    }

    case 'PEER_CONNECTED': {
      if (state.connectedPeers.find(p => p.id === action.peer.id)) return state;
      return { ...state, connectedPeers: [...state.connectedPeers, action.peer] };
    }

    case 'PEER_DISCONNECTED': {
      return { ...state, connectedPeers: state.connectedPeers.filter(p => p.id !== action.peerId) };
    }

    // ── Remote sync (from controller over DataChannel) ─────────────────────
    case 'REMOTE_SYNC': {
      const r = action.payload;
      return {
        ...state,
        timerState: r.timerState,
        currentSlotIndex: r.currentSlotIndex,
        slotElapsedMs: r.slotElapsedMs,
        slotStartedAt: r.timerState === 'running' || r.timerState === 'overtime'
          ? performance.now() - (Date.now() - r.serverWallClock)
          : null,
        slots: r.slots,
        thresholds: r.thresholds,
        customMessage: r.customMessage,
        sessionStartWallClock: r.sessionStartWallClock,
      };
    }

    case 'REMOTE_TICK_SYNC': {
      const r = action.payload;
      if (state.timerState !== r.timerState) {
        return { ...state, timerState: r.timerState };
      }
      return state;
    }

    default:
      return state;
  }
}
