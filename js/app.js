import { getState, dispatch } from './state.js';
import { startTick } from './timer.js';
import { initDisplay } from './display.js';
import { initController } from './controller.js';
import { PairingManager } from './pairing.js';

const APP_VERSION = 'v1.2';

let _pairing = null;

async function main() {
  const state = getState();

  // Apply saved theme
  document.documentElement.setAttribute('data-theme', state.theme);
  document.getElementById('theme-toggle').textContent = state.theme === 'dark' ? '🌙' : '☀️';

  // Set body role
  document.body.setAttribute('data-role', state.role);

  // Inject version
  for (const id of ['ctrl-version', 'd-version']) {
    const el = document.getElementById(id);
    if (el) el.textContent = APP_VERSION;
  }

  // Theme toggle
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const current = getState().theme;
    const next = current === 'dark' ? 'light' : 'dark';
    dispatch({ type: 'THEME_SET', theme: next });
    document.documentElement.setAttribute('data-theme', next);
    document.getElementById('theme-toggle').textContent = next === 'dark' ? '🌙' : '☀️';
    _pairing?.broadcast({ type: 'THEME_SET', payload: { theme: next } });
  });

  // Role switcher (via URL param — reload with new param)
  // Allow ?role=both to show both panels
  if (state.role === 'both') {
    document.body.removeAttribute('data-role');
  }

  // Start pairing
  _pairing = new PairingManager();
  await _pairing.start();

  // Start timer tick loop
  startTick();

  // Init views
  if (state.role === 'display' || state.role === 'both') {
    initDisplay(_pairing);
  }
  if (state.role === 'controller' || state.role === 'both') {
    initController(_pairing);
  }

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }

  // PWA install prompt
  let _installPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _installPrompt = e;
    if (!localStorage.getItem('ept-install-dismissed')) {
      document.getElementById('install-banner')?.classList.remove('hidden');
    }
  });

  document.getElementById('btn-install')?.addEventListener('click', async () => {
    if (!_installPrompt) return;
    await _installPrompt.prompt();
    const { outcome } = await _installPrompt.userChoice;
    if (outcome === 'accepted') {
      document.getElementById('install-banner')?.classList.add('hidden');
    }
    _installPrompt = null;
  });

  document.getElementById('btn-install-dismiss')?.addEventListener('click', () => {
    localStorage.setItem('ept-install-dismissed', '1');
    document.getElementById('install-banner')?.classList.add('hidden');
  });

  // Handle ?join= param — open pairing modal if role is controller
  const params = new URLSearchParams(location.search);
  const joinCode = params.get('join');
  if (joinCode && (state.role === 'controller' || state.role === 'both')) {
    document.getElementById('join-code-input').value = joinCode.toUpperCase();
    document.getElementById('pairing-modal')?.classList.remove('hidden');
  }

  // Handle ?sdpoffer= — display's offer scanned by controller → auto-fill "I receive offer"
  const sdpOffer = params.get('sdpoffer');
  if (sdpOffer && (state.role === 'controller' || state.role === 'both')) {
    const offerInput = document.getElementById('sdp-incoming-offer');
    if (offerInput) offerInput.value = sdpOffer;
    document.getElementById('pairing-modal')?.classList.remove('hidden');
    document.querySelector('.pairing-tab[data-tab="manual"]')?.click();
    document.querySelector('.ctrl-sdp-tab[data-sdp="receive"]')?.click();
  }

  // Handle ?sdpanswer= — controller's answer scanned by display → auto-apply
  const sdpAnswer = params.get('sdpanswer');
  if (sdpAnswer && (state.role === 'display' || state.role === 'both')) {
    setTimeout(() => _pairing?.applyDisplayAnswer(sdpAnswer), 800);
  }
}

main().catch(console.error);
