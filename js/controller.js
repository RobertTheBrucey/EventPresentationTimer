import { getState, dispatch, subscribe } from './state.js';
import { computeTimerValues, trafficLight } from './timer.js';
import { parseSchedule } from './schedule.js';
import { formatTime, showToast, debounce } from './utils.js';
import { renderQR } from './qrcode.js';

const $ = id => document.getElementById(id);

let _pairingManager = null;
let _editingSlotId = null;
let _rafId = null;

export function initController(pairingManager) {
  _pairingManager = pairingManager;
  _bindTimerButtons();
  _bindMessageSection();
  _bindThresholdInputs();
  _bindScheduleSection();
  _bindSlotModal();
  _bindImportModal();
  _bindPairingModal();
  subscribe(_onStateChange);
  _render(getState());
  _startRaf();

  pairingManager.onDiscoveredChange = peers => _renderDiscovered(peers, 'ctrl-discovered-list', 'ctrl-discovered-empty');
}

// ── Timer buttons ────────────────────────────────────────────────────

function _bindTimerButtons() {
  $('btn-start')?.addEventListener('click', () => {
    const s = getState();
    if (s.timerState === 'paused') {
      _dispatchAndBroadcast({ type: 'TIMER_RESUME' });
    } else {
      _dispatchAndBroadcast({ type: 'TIMER_START' });
    }
  });
  $('btn-pause')?.addEventListener('click',  () => _dispatchAndBroadcast({ type: 'TIMER_PAUSE' }));
  $('btn-stop')?.addEventListener('click',   () => _dispatchAndBroadcast({ type: 'TIMER_STOP' }));
  $('btn-reset')?.addEventListener('click',  () => _dispatchAndBroadcast({ type: 'TIMER_RESET' }));
  $('btn-next')?.addEventListener('click',   () => {
    const s = getState();
    const next = s.currentSlotIndex + 1;
    if (next < s.slots.length) {
      _dispatchAndBroadcast({ type: 'SLOT_ADVANCE', toIndex: next, payload: { toIndex: next } });
    }
  });

  document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const s = getState();
    if (e.code === 'Space') {
      e.preventDefault();
      if (s.timerState === 'idle' || s.timerState === 'stopped') {
        _dispatchAndBroadcast({ type: 'TIMER_START' });
      } else if (s.timerState === 'running' || s.timerState === 'overtime') {
        _dispatchAndBroadcast({ type: 'TIMER_PAUSE' });
      } else if (s.timerState === 'paused') {
        _dispatchAndBroadcast({ type: 'TIMER_RESUME' });
      }
    } else if (e.code === 'KeyN') {
      const next = s.currentSlotIndex + 1;
      if (next < s.slots.length) {
        _dispatchAndBroadcast({ type: 'SLOT_ADVANCE', toIndex: next, payload: { toIndex: next } });
      }
    } else if (e.code === 'Escape') {
      _dispatchAndBroadcast({ type: 'TIMER_STOP' });
    }
  });
}

// ── Message section ──────────────────────────────────────────────────

function _bindMessageSection() {
  const send = () => {
    const input = $('message-input');
    const msg = input?.value.trim() ?? '';
    _dispatchAndBroadcast({ type: 'MESSAGE_SET', message: msg, payload: { message: msg } });
    if (input) input.value = '';
    if (msg) showToast('Message sent to displays', 'success');
  };

  $('btn-send-message')?.addEventListener('click', send);
  $('message-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  $('btn-clear-message')?.addEventListener('click', () => {
    _dispatchAndBroadcast({ type: 'MESSAGE_CLEAR', payload: {} });
    const input = $('message-input');
    if (input) input.value = '';
  });
}

// ── Threshold inputs ─────────────────────────────────────────────────

function _bindThresholdInputs() {
  const save = debounce(() => {
    const yellow = parseInt($('threshold-yellow')?.value ?? '300', 10);
    const red    = parseInt($('threshold-red')?.value    ?? '60',  10);
    if (!isNaN(yellow) && !isNaN(red)) {
      const thresholds = { yellowAt: yellow, redAt: red };
      dispatch({ type: 'THRESHOLDS_SET', thresholds });
      _pairingManager?.broadcast({ type: 'THRESHOLDS_SET', payload: { thresholds } });
    }
  }, 400);
  $('threshold-yellow')?.addEventListener('input', save);
  $('threshold-red')?.addEventListener('input', save);
}

// ── Schedule section ─────────────────────────────────────────────────

function _bindScheduleSection() {
  $('btn-add-slot')?.addEventListener('click',  () => _openSlotModal(null));
  $('btn-import')?.addEventListener('click',    () => $('import-modal')?.classList.remove('hidden'));
}

// ── Slot modal ───────────────────────────────────────────────────────

function _openSlotModal(slot) {
  _editingSlotId = slot?.id ?? null;
  const modal = $('slot-modal');
  if (!modal) return;
  $('slot-modal-title').textContent = slot ? 'Edit Speaker' : 'Add Speaker';
  $('slot-edit-id').value = slot?.id ?? '';
  $('slot-edit-name').value = slot?.name ?? '';
  $('slot-edit-title').value = slot?.title ?? '';
  $('slot-edit-duration').value = slot
    ? `${Math.floor(slot.durationSec / 60)}:${String(slot.durationSec % 60).padStart(2, '0')}`
    : '';
  $('slot-edit-notes').value = slot?.operatorNotes ?? '';
  modal.classList.remove('hidden');
  setTimeout(() => $('slot-edit-name')?.focus(), 50);
}

function _bindSlotModal() {
  $('btn-slot-cancel')?.addEventListener('click', () => $('slot-modal')?.classList.add('hidden'));
  $('slot-modal')?.addEventListener('click', e => {
    if (e.target === $('slot-modal')) $('slot-modal').classList.add('hidden');
  });

  $('btn-slot-save')?.addEventListener('click', () => {
    const name = $('slot-edit-name')?.value.trim() ?? '';
    if (!name) { showToast('Speaker name is required', 'error'); return; }

    const durationRaw = $('slot-edit-duration')?.value.trim() ?? '';
    const durationSec = _parseDuration(durationRaw);
    if (isNaN(durationSec) || durationSec <= 0) {
      showToast('Invalid duration — use MM:SS or minutes', 'error'); return;
    }

    const slot = {
      id: _editingSlotId ?? undefined,
      name,
      title: $('slot-edit-title')?.value.trim() ?? '',
      durationSec,
      operatorNotes: $('slot-edit-notes')?.value.trim() ?? '',
    };

    dispatch({ type: _editingSlotId ? 'SLOT_UPDATE' : 'SLOT_ADD', slot });
    _broadcastSchedule();
    $('slot-modal')?.classList.add('hidden');
  });
}

// ── Import modal ─────────────────────────────────────────────────────

function _bindImportModal() {
  $('btn-import-cancel')?.addEventListener('click', () => $('import-modal')?.classList.add('hidden'));
  $('import-modal')?.addEventListener('click', e => {
    if (e.target === $('import-modal')) $('import-modal').classList.add('hidden');
  });

  $('import-file')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    $('import-text').value = await file.text();
  });

  $('btn-import-apply')?.addEventListener('click', () => {
    const text = $('import-text')?.value.trim() ?? '';
    if (!text) { showToast('No content to import', 'error'); return; }
    try {
      const slots = parseSchedule(text);
      dispatch({ type: 'SCHEDULE_SET', slots });
      _broadcastSchedule();
      $('import-modal')?.classList.add('hidden');
      $('import-text').value = '';
      if ($('import-file')) $('import-file').value = '';
      showToast(`Imported ${slots.length} speaker(s)`, 'success');
    } catch (err) {
      showToast(`Import error: ${err.message}`, 'error');
    }
  });
}

// ── Pairing modal ────────────────────────────────────────────────────

function _bindPairingModal() {
  $('btn-pair')?.addEventListener('click', () => $('pairing-modal')?.classList.remove('hidden'));
  $('btn-pairing-close')?.addEventListener('click', () => $('pairing-modal')?.classList.add('hidden'));
  $('pairing-modal')?.addEventListener('click', e => {
    if (e.target === $('pairing-modal')) $('pairing-modal').classList.add('hidden');
  });

  document.querySelectorAll('.pairing-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.pairing-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pairing-tab-content').forEach(c => c.classList.add('hidden'));
      tab.classList.add('active');
      $(`pairing-tab-${tab.dataset.tab}`)?.classList.remove('hidden');
    });
  });

  $('btn-join-code')?.addEventListener('click', () => {
    const code = $('join-code-input')?.value.trim().toUpperCase() ?? '';
    if (code.length !== 6) { showToast('Enter a 6-character code', 'error'); return; }
    _pairingManager?.joinByCode(code);
    $('pairing-modal')?.classList.add('hidden');
  });

  $('join-code-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-join-code')?.click();
  });

  $('btn-apply-sdp')?.addEventListener('click', () => {
    const answer = $('sdp-answer-in')?.value.trim() ?? '';
    if (!answer) { showToast('Paste the answer SDP first', 'error'); return; }
    _pairingManager?.applyManualAnswer(answer);
    $('pairing-modal')?.classList.add('hidden');
  });

  // SDP sub-tabs: "I send offer" vs "I receive offer"
  document.querySelectorAll('.ctrl-sdp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ctrl-sdp-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const mode = tab.dataset.sdp;
      $('ctrl-sdp-offer')?.classList.toggle('hidden', mode !== 'offer');
      $('ctrl-sdp-receive')?.classList.toggle('hidden', mode !== 'receive');
    });
  });

  // Copy controller's offer
  $('btn-copy-ctrl-offer')?.addEventListener('click', () => {
    const text = $('sdp-offer-out')?.value ?? '';
    navigator.clipboard?.writeText(text)
      .then(() => showToast('Copied to clipboard', 'success'))
      .catch(() => showToast('Copy failed — select text manually', 'error'));
  });

  // Generate answer from display's offer
  $('btn-generate-answer')?.addEventListener('click', async () => {
    const offerBlob = $('sdp-incoming-offer')?.value.trim() ?? '';
    if (!offerBlob) { showToast("Paste the display's offer first", 'error'); return; }
    try {
      const answerBlob = await _pairingManager?.acceptIncomingOffer(offerBlob);
      const answerOut = $('sdp-answer-out');
      if (answerOut) answerOut.value = answerBlob;
      const answerQr = $('ctrl-answer-qr');
      if (answerQr) {
        const url = `${location.origin}${location.pathname}?sdpanswer=${encodeURIComponent(answerBlob)}`;
        renderQR(answerQr, url);
      }
      $('ctrl-answer-wrap')?.classList.remove('hidden');
      showToast('Answer generated — show it to the display', 'success');
    } catch (err) {
      showToast(`SDP error: ${err.message}`, 'error');
    }
  });

  // Copy controller's answer
  $('btn-copy-ctrl-answer')?.addEventListener('click', () => {
    const text = $('sdp-answer-out')?.value ?? '';
    navigator.clipboard?.writeText(text)
      .then(() => showToast('Copied to clipboard', 'success'))
      .catch(() => showToast('Copy failed — select text manually', 'error'));
  });
}

// ── Render ───────────────────────────────────────────────────────────

function _startRaf() {
  if (_rafId) return;
  const loop = () => {
    _rafId = requestAnimationFrame(loop);
    _renderCountdown(getState());
  };
  _rafId = requestAnimationFrame(loop);
}

function _onStateChange(state) {
  _render(state);
}

function _render(state) {
  _renderTimerButtons(state);
  _renderScheduleTable(state);
  _renderPeerCount(state);
  _syncThresholdInputs(state);
}

function _renderCountdown(state) {
  const el = $('ctrl-countdown');
  if (!el) return;
  const { remainingMs, overtimeMs } = computeTimerValues(state);
  const isOvertime = state.timerState === 'overtime';
  const noSlots = state.timerState === 'idle' && state.slots.length === 0;

  el.textContent = noSlots ? '--:--'
    : isOvertime ? `+${formatTime(overtimeMs)}`
    : formatTime(Math.max(0, remainingMs));

  el.className = noSlots ? '' : `traffic-${trafficLight(remainingMs, state.thresholds, state.timerState)}`;

  const slot = state.slots[state.currentSlotIndex];
  const nameEl = $('ctrl-speaker-name');
  const titleEl = $('ctrl-speaker-title');
  if (nameEl) nameEl.textContent = slot?.name ?? '—';
  if (titleEl) titleEl.textContent = slot?.title ?? '';
}

function _renderTimerButtons(state) {
  const ts = state.timerState;
  const hasSlots = state.slots.length > 0;
  const hasNext = state.currentSlotIndex + 1 < state.slots.length;
  const startBtn = $('btn-start');
  if (startBtn) {
    startBtn.disabled = !hasSlots || ts === 'running' || ts === 'overtime';
    startBtn.textContent = ts === 'paused' ? '▶ Resume' : '▶ Start';
  }
  _setDisabled('btn-pause', ts !== 'running' && ts !== 'overtime');
  _setDisabled('btn-stop',  ts === 'idle' || ts === 'stopped');
  _setDisabled('btn-reset', ts === 'idle');
  _setDisabled('btn-next',  !hasNext);
}

function _renderScheduleTable(state) {
  const tbody = $('schedule-tbody');
  const emptyMsg = $('schedule-empty');
  if (!tbody) return;

  if (!state.slots.length) {
    tbody.innerHTML = '';
    emptyMsg?.classList.remove('hidden');
    return;
  }
  emptyMsg?.classList.add('hidden');

  tbody.innerHTML = state.slots.map((slot, i) => {
    const dur = `${Math.floor(slot.durationSec / 60)}:${String(slot.durationSec % 60).padStart(2, '0')}`;
    return `<tr class="${i === state.currentSlotIndex ? 'active-slot' : ''}" data-id="${slot.id}" data-idx="${i}">
      <td>${i + 1}</td>
      <td>${_esc(slot.name)}</td>
      <td>${_esc(slot.title || '—')}</td>
      <td style="font-family:var(--font-mono)">${dur}</td>
      <td class="notes-cell" title="${_esc(slot.operatorNotes || '')}">${_esc(slot.operatorNotes || '')}</td>
      <td>
        <div class="slot-actions">
          <button class="btn-slot-up"     data-id="${slot.id}">↑</button>
          <button class="btn-slot-down"   data-id="${slot.id}">↓</button>
          <button class="btn-slot-edit"   data-id="${slot.id}">✏</button>
          <button class="btn-slot-delete" data-id="${slot.id}">✕</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  tbody.onclick = e => {
    const btn = e.target.closest('button[data-id]');
    const s = getState();
    if (btn) {
      e.stopPropagation();
      const id = btn.dataset.id;
      const idx = s.slots.findIndex(sl => sl.id === id);
      if (btn.classList.contains('btn-slot-up') && idx > 0) {
        dispatch({ type: 'SLOT_REORDER', from: idx, to: idx - 1 });
        _broadcastSchedule();
      } else if (btn.classList.contains('btn-slot-down') && idx < s.slots.length - 1) {
        dispatch({ type: 'SLOT_REORDER', from: idx, to: idx + 1 });
        _broadcastSchedule();
      } else if (btn.classList.contains('btn-slot-edit')) {
        _openSlotModal(s.slots[idx]);
      } else if (btn.classList.contains('btn-slot-delete')) {
        if (confirm(`Delete "${s.slots[idx].name}"?`)) {
          dispatch({ type: 'SLOT_DELETE', id });
          _broadcastSchedule();
        }
      }
      return;
    }
    // Row click — set as active slot
    const row = e.target.closest('tr[data-id]');
    if (row) {
      const idx = parseInt(row.dataset.idx, 10);
      if (idx !== s.currentSlotIndex) {
        _dispatchAndBroadcast({ type: 'SLOT_ADVANCE', toIndex: idx, payload: { toIndex: idx } });
      }
    }
  };
}

function _renderPeerCount(state) {
  const el = $('peer-count');
  if (!el) return;
  const n = state.connectedPeers.length;
  el.textContent = n === 0 ? 'No devices connected'
    : n === 1 ? '1 device connected'
    : `${n} devices connected`;
}

function _syncThresholdInputs(state) {
  const yEl = $('threshold-yellow');
  const rEl = $('threshold-red');
  if (yEl && document.activeElement !== yEl) yEl.value = state.thresholds.yellowAt;
  if (rEl && document.activeElement !== rEl) rEl.value = state.thresholds.redAt;
}

// ── Helpers ──────────────────────────────────────────────────────────

function _dispatchAndBroadcast(action) {
  dispatch(action);
  const { type, payload, ...rest } = action;
  _pairingManager?.broadcast({ type, payload: payload ?? rest });
}

function _broadcastSchedule() {
  const s = getState();
  const slots = s.slots.map(({ id, name, title, durationSec }) => ({ id, name, title, durationSec }));
  _pairingManager?.broadcast({ type: 'SCHEDULE_SET', payload: { slots } });
}

function _setDisabled(id, disabled) {
  const el = $(id);
  if (el) el.disabled = disabled;
}

function _parseDuration(str) {
  str = String(str).trim();
  if (str.includes(':')) {
    const parts = str.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return NaN;
  }
  const n = parseFloat(str);
  return isNaN(n) ? NaN : Math.round(n * 60);
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _renderDiscovered(peers, listId, emptyId) {
  const list = $(listId);
  const empty = $(emptyId);
  if (!list) return;
  list.innerHTML = '';
  if (!peers.length) {
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');
  for (const peer of peers) {
    const row = document.createElement('div');
    row.className = 'discovered-peer';
    const label = document.createElement('span');
    label.textContent = peer.role.charAt(0).toUpperCase() + peer.role.slice(1);
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.textContent = 'Connect';
    btn.addEventListener('click', () => {
      _pairingManager?.connectToLocalPeer(peer.peerId);
      $('pairing-modal')?.classList.add('hidden');
    });
    row.append(label, btn);
    list.appendChild(row);
  }
}
