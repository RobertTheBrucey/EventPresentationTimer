// Thin ES module wrapper around the davidshimjs-qrcodejs global.
// The library itself is loaded as a classic <script> in index.html
// and exposes window.QRCode with auto-sizing up to QR version 40.

export function renderQR(container, text, size = 200) {
  if (!container) return;
  container.innerHTML = '';
  try {
    new window.QRCode(container, {
      text,
      width: size,
      height: size,
      colorDark:  '#000000',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.M,
    });
  } catch {
    // Data too large or encoding error — silent; callers provide a copy button
  }
}
