import { subscribe, getState } from './state.js';
import { computeTimerValues, computePlannedEnd, trafficLight } from './timer.js';
import { formatTime, formatWallClock, showToast } from './utils.js';
import { renderQR } from './qrcode.js';

const $ = id => document.getElementById(id);

let _rafId = null;
let _flashTimeout = null;
let _hasFlashed = false;
let _flashActive = false;
let _pairingManual = null; // null = auto, true = forced open, false = forced closed

// Camera/scan state
let _scanStream = null;
let _scanAnimFrame = null;
let _barcodeDetector = null;

export function initDisplay(pairingManager) {
  subscribe(_onStateChange);
  _startRaf();
  setInterval(_updateWallClock, 1000);
  _updateWallClock();

  if (pairingManager) _initPairingControls(pairingManager);
}

function _onStateChange(state) {
  _renderSpeakerInfo(state);
  _renderCustomMessage(state);
  _renderPairingPanel(state);
}

function _startRaf() {
  function loop() {
    _rafId = requestAnimationFrame(loop);
    const state = getState();
    _renderCountdown(state);
    _renderTrafficLight(state);
  }
  _rafId = requestAnimationFrame(loop);
}

function _renderCountdown(state) {
  const el = $('countdown-time');
  if (!el) return;

  const { remainingMs, overtimeMs } = computeTimerValues(state);
  const isOvertime = state.timerState === 'overtime';
  const isIdle = state.timerState === 'idle';

  if (isIdle && state.slots.length === 0) {
    el.textContent = '--:--';
    el.removeAttribute('data-overtime');
    return;
  }

  if (isOvertime) {
    el.textContent = formatTime(overtimeMs);
    el.setAttribute('data-overtime', 'true');
    _maybeFlash(state);
  } else {
    el.textContent = formatTime(Math.max(0, remainingMs));
    el.removeAttribute('data-overtime');
    _hasFlashed = false;
  }

  // Planned end
  const endEl = $('planned-end');
  if (endEl) {
    const plannedEnd = computePlannedEnd(state);
    endEl.textContent = plannedEnd && !isOvertime ? formatWallClock(plannedEnd) : '';
  }
}

function _renderTrafficLight(state) {
  const bg = $('display-bg');
  if (!bg) return;

  const { remainingMs } = computeTimerValues(state);
  const light = trafficLight(remainingMs, state.thresholds, state.timerState);

  bg.className = `traffic-${light}`;

  if (light === 'overtime') {
    // Flash only while overtime is active (handled by _maybeFlash for first trigger)
    // Continuous flash is applied via CSS animation after short delay
  }
}

function _maybeFlash(state) {
  if (_flashActive) return;
  _flashActive = true;

  const bg = $('display-bg');
  if (!bg) return;

  bg.classList.add('flash-overtime');

  // Stop flashing after 3 seconds
  clearTimeout(_flashTimeout);
  _flashTimeout = setTimeout(() => {
    bg?.classList.remove('flash-overtime');
    _flashActive = false;
  }, 3000);
}

function _renderSpeakerInfo(state) {
  const slot = state.slots[state.currentSlotIndex];
  const nextSlot = state.slots[state.currentSlotIndex + 1];

  const nameEl = $('speaker-name');
  const titleEl = $('speaker-title');
  const nextRowEl = $('next-speaker-row');
  const nextNameEl = $('next-speaker-name');

  if (nameEl) nameEl.textContent = slot?.name ?? '';
  if (titleEl) titleEl.textContent = slot?.title ?? '';

  if (nextRowEl && nextNameEl) {
    if (nextSlot?.name) {
      nextNameEl.textContent = nextSlot.name;
      nextRowEl.classList.remove('hidden');
    } else {
      nextRowEl.classList.add('hidden');
    }
  }
}

function _renderCustomMessage(state) {
  const el = $('custom-message');
  if (!el) return;
  if (state.customMessage) {
    el.textContent = state.customMessage;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function _renderPairingPanel(state) {
  const panel = $('pairing-panel');
  const btn = $('display-settings-btn');
  if (!panel) return;

  const hasController = state.connectedPeers.some(p => p.role === 'controller' || p.role === 'both');

  if (hasController) {
    _pairingManual = null; // reset override on connect
  }

  // Show when: no controller and user hasn't explicitly closed it; OR user forced it open
  const show = _pairingManual === true || (!hasController && _pairingManual !== false);
  panel.classList.toggle('hidden', !show);
  btn?.classList.toggle('active', show);
}

function _updateWallClock() {
  const el = $('wall-clock');
  if (el) el.textContent = formatWallClock(new Date());
}

// ── Display pairing UI ───────────────────────────────────────────────

function _initPairingControls(pairing) {
  // Settings cog — toggle pairing panel
  $('display-settings-btn')?.addEventListener('click', () => {
    const panel = $('pairing-panel');
    const btn = $('display-settings-btn');
    if (!panel) return;
    const isOpen = !panel.classList.contains('hidden');
    _pairingManual = !isOpen; // flip
    panel.classList.toggle('hidden', isOpen);
    btn?.classList.toggle('active', !isOpen);
  });

  // Tab switching
  document.querySelectorAll('.d-pair-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.d-pair-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.d-pair-content').forEach(c => c.classList.add('hidden'));
      tab.classList.add('active');
      $(`d-pair-${tab.dataset.tab}`)?.classList.remove('hidden');

      if (tab.dataset.tab === 'sdp') _activateSdpTab(pairing);
      if (tab.dataset.tab !== 'scan') _stopScan();
    });
  });

  // Scan tab — camera
  $('d-btn-start-scan')?.addEventListener('click', () => _startCameraScan(pairing));

  // Scan tab — file upload fallback
  $('d-scan-file')?.addEventListener('change', e => _scanFile(e, pairing));

  // Code tab
  $('d-btn-join-code')?.addEventListener('click', () => {
    const code = $('d-join-code-input')?.value.trim().toUpperCase() ?? '';
    if (code.length !== 6) { showToast('Enter a 6-character code', 'error'); return; }
    pairing.joinByCode(code);
  });
  $('d-join-code-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') $('d-btn-join-code')?.click();
  });

  // SDP tab — copy offer
  $('d-btn-copy-offer')?.addEventListener('click', () => {
    const text = $('d-offer-text')?.value ?? '';
    navigator.clipboard?.writeText(text)
      .then(() => showToast('Copied to clipboard', 'success'))
      .catch(() => showToast('Copy failed — select text manually', 'error'));
  });

  // SDP tab — apply controller's answer
  $('d-btn-apply-answer')?.addEventListener('click', () => {
    const blob = $('d-answer-input')?.value.trim() ?? '';
    if (!blob) { showToast('Paste the controller\'s answer first', 'error'); return; }
    pairing.applyDisplayAnswer(blob);
  });
}

let _sdpOfferGenerated = false;

async function _activateSdpTab(pairing) {
  if (_sdpOfferGenerated) return;  // Only generate once per session
  _sdpOfferGenerated = true;

  const offerText = $('d-offer-text');
  if (!offerText) return;

  try {
    const blob = await pairing.generateDisplayOffer();
    offerText.value = blob;
    const offerQr = $('d-offer-qr');
    if (offerQr) renderQR(offerQr, blob, 180); // encode raw blob — smaller than full URL
  } catch {
    showToast('Could not generate SDP offer', 'error');
    _sdpOfferGenerated = false;
  }
}

async function _startCameraScan(pairing) {
  const video = $('d-scan-video');
  const status = $('d-scan-status');
  if (!video) return;

  if (_scanStream) { _stopScan(); return; }

  try {
    _scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = _scanStream;
    video.classList.add('active');
    const btn = $('d-btn-start-scan');
    if (btn) btn.textContent = 'Stop Camera';
    if (status) status.textContent = 'Scanning for QR code…';

    if ('BarcodeDetector' in window) {
      _barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
      _runScanLoop(pairing, video, status);
    } else {
      if (status) status.textContent = 'Camera active — use "Upload Image" to scan QR';
    }
  } catch {
    if (status) status.textContent = 'Camera access denied — use "Upload Image" instead';
  }
}

function _runScanLoop(pairing, video, status) {
  async function tick() {
    if (!_scanStream) return;
    try {
      const codes = await _barcodeDetector.detect(video);
      if (codes.length > 0) {
        _stopScan();
        _handleScannedValue(codes[0].rawValue, pairing, status);
        return;
      }
    } catch { /* ignore */ }
    _scanAnimFrame = requestAnimationFrame(tick);
  }
  _scanAnimFrame = requestAnimationFrame(tick);
}

async function _scanFile(e, pairing) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';

  const status = $('d-scan-status');
  if (!('BarcodeDetector' in window)) {
    if (status) status.textContent = 'QR scanning not supported in this browser';
    return;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const codes = await detector.detect(bitmap);
    if (!codes.length) { if (status) status.textContent = 'No QR code found in image'; return; }
    _handleScannedValue(codes[0].rawValue, pairing, status);
  } catch {
    if (status) status.textContent = 'Could not read image';
  }
}

function _handleScannedValue(raw, pairing, status) {
  let joinCode = null;
  let sdpOffer = null;
  let sdpAnswer = null;

  try {
    const url = new URL(raw);
    joinCode  = url.searchParams.get('join');
    sdpOffer  = url.searchParams.get('sdpoffer');
    sdpAnswer = url.searchParams.get('sdpanswer');
  } catch {
    const trimmed = raw.trim();
    if (/^[A-Z0-9]{6}$/i.test(trimmed)) {
      joinCode = trimmed.toUpperCase();
    } else {
      // Try to detect a raw SDP blob (base64-encoded JSON with offererId/answererId)
      try {
        const parsed = JSON.parse(atob(trimmed));
        if (parsed.offererId) sdpOffer = trimmed;
        else if (parsed.answererId) sdpAnswer = trimmed;
      } catch { /* not a blob */ }
    }
  }

  if (joinCode) {
    if (status) status.textContent = `Connecting with code ${joinCode.toUpperCase()}…`;
    pairing.joinByCode(joinCode.toUpperCase());
  } else if (sdpAnswer) {
    if (status) status.textContent = 'Applying SDP answer…';
    pairing.applyDisplayAnswer(sdpAnswer);
  } else if (sdpOffer) {
    if (status) status.textContent = 'Processing controller offer…';
    pairing.acceptIncomingOffer(sdpOffer).then(answerBlob => {
      navigator.clipboard?.writeText(answerBlob).catch(() => {});
      showToast('Answer generated and copied — paste it in the controller', 'success');
      if (status) status.textContent = 'Answer copied to clipboard — paste in controller\'s Manual SDP';
    }).catch(err => {
      if (status) status.textContent = `SDP error: ${err.message}`;
    });
  } else {
    if (status) status.textContent = 'QR code not recognised';
  }
}

function _stopScan() {
  if (_scanAnimFrame) { cancelAnimationFrame(_scanAnimFrame); _scanAnimFrame = null; }
  if (_scanStream) { _scanStream.getTracks().forEach(t => t.stop()); _scanStream = null; }
  const video = $('d-scan-video');
  if (video) { video.srcObject = null; video.classList.remove('active'); }
  const btn = $('d-btn-start-scan');
  if (btn) btn.textContent = 'Open Camera';
}
