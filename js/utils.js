/**
 * Format milliseconds as MM:SS or H:MM:SS
 * @param {number} ms
 * @param {boolean} showHours - force hours display
 * @returns {string}
 */
export function formatTime(ms, showHours = false) {
  const totalSec = Math.abs(Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const neg = ms < 0 ? '-' : '';
  const pad = n => String(n).padStart(2, '0');
  if (h > 0 || showHours) return `${neg}${h}:${pad(m)}:${pad(s)}`;
  return `${neg}${pad(m)}:${pad(s)}`;
}

/**
 * Format Date as HH:MM
 * @param {Date} date
 * @returns {string}
 */
export function formatWallClock(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Generate a 6-char uppercase room code (no 0/O/I/1 for legibility)
 * @returns {string}
 */
export function generateCode() {
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  for (const b of arr) code += CHARS[b % CHARS.length];
  return code;
}

/**
 * Generate a UUID v4
 * @returns {string}
 */
export function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
}

/**
 * Debounce a function
 * @param {Function} fn
 * @param {number} delay
 * @returns {Function}
 */
export function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Parse a duration string "MM:SS" or plain minutes into seconds
 * @param {string} str
 * @returns {number} seconds, or NaN if invalid
 */
export function parseDuration(str) {
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

/**
 * Show a transient toast notification
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 */
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

/**
 * Get the device's local IP address candidates via WebRTC (best-effort)
 * @returns {Promise<string[]>}
 */
export async function getLocalIPs() {
  const ips = new Set();
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel('');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 1500);
      pc.onicecandidate = e => {
        if (!e.candidate) { clearTimeout(timeout); resolve(); return; }
        const m = e.candidate.candidate.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g);
        if (m) m.forEach(ip => { if (!ip.startsWith('127.')) ips.add(ip); });
      };
    });
    pc.close();
  } catch {
    // not critical
  }
  return [...ips];
}

/**
 * Derive subnet peers to probe from a local IP
 * e.g. 192.168.1.42 → probes 192.168.1.1 … 192.168.1.20
 * @param {string} localIP
 * @returns {string[]}
 */
export function subnetPeers(localIP) {
  const parts = localIP.split('.');
  if (parts.length !== 4) return [];
  const base = parts.slice(0, 3).join('.');
  return Array.from({ length: 20 }, (_, i) => `${base}.${i + 1}`);
}
