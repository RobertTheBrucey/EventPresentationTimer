# CLAUDE.md — Developer Guide for EventPresentationTimer

## Project Overview

Browser-based PWA speech/event timer. A **controller** manages a speaker schedule and controls the timer; **display** screens show the countdown, speaker info, and traffic-light warnings. Devices communicate peer-to-peer over WebRTC DataChannels. No build step — pure vanilla HTML/CSS/ES Modules.

## Architecture

```
index.html  →  js/app.js  (bootstrap)
                 ├── js/state.js       (single state object + event bus)
                 ├── js/timer.js       (state machine + tick + helpers)
                 ├── js/display.js     (display view, rAF loop)
                 ├── js/controller.js  (controller view, event handlers)
                 └── js/pairing.js     (pairing orchestrator)
                       ├── js/webrtc.js        (PeerManager, DataChannel)
                       ├── js/relay-client.js  (WebSocket relay adapter)
                       └── js/qrcode.js        (QR code renderer)
```

- Role selected via `?role=controller|display|both` URL param (default: controller)
- `state.js` is the single source of truth — never mutate state directly
- Views subscribe via `subscribe(handler)` or use `requestAnimationFrame` for smooth rendering

## File Map

| File | Purpose |
|---|---|
| `index.html` | Single HTML entry point; contains all panel markup |
| `manifest.webmanifest` | PWA manifest |
| `sw.js` | Service Worker — cache-first, all assets precached |
| `css/base.css` | CSS custom properties, reset, utility classes |
| `css/display.css` | Display screen styles (countdown, traffic light, flash) |
| `css/controller.css` | Controller panel styles (schedule table, modals) |
| `css/theme.css` | Dark/light theme overrides, scrollbar, install banner |
| `js/app.js` | Bootstrap: reads role, starts pairing, inits views, registers SW |
| `js/state.js` | State object, `dispatch()`, `subscribe()`, reducer |
| `js/timer.js` | Timer state machine, tick, `computeTimerValues()`, `buildSyncPayload()` |
| `js/schedule.js` | Slot CRUD, CSV/JSON parsers |
| `js/webrtc.js` | `PeerManager` class — RTCPeerConnection, DataChannel, mesh |
| `js/pairing.js` | `PairingManager` — LAN probe → QR → manual code orchestration |
| `js/relay-client.js` | WebSocket client for `relay/relay.js` |
| `js/qrcode.js` | Self-contained QR code renderer (canvas) |
| `js/display.js` | Display view: countdown, traffic light, speaker info |
| `js/controller.js` | Controller view: schedule, timer buttons, import, pairing modals |
| `js/utils.js` | `formatTime()`, `generateCode()`, `uuid()`, `debounce()`, LAN utilities |
| `relay/relay.js` | Optional Node.js WebSocket signaling server |
| `relay/package.json` | Relay deps (`ws@8`) |
| `icons/` | PNG icons (192, 512, maskable) generated from `icon.svg` |
| `_headers` | Cloudflare Pages HTTP headers (`sw.js` must be no-cache) |
| `_redirects` | Cloudflare Pages redirects (currently empty) |

## State Management

All mutable app state lives in `js/state.js` as a plain object.

```js
import { getState, dispatch, subscribe } from './state.js';

// Read
const state = getState();

// Write — all mutations go through dispatch
dispatch({ type: 'TIMER_START' });

// Subscribe to changes
const unsubscribe = subscribe((state, action) => {
  // re-render
});
```

The reducer handles all action types. Never mutate the state object directly.

State is **not persisted** across page reloads (by design — each session is fresh). The peer ID and theme preference are stored in `localStorage`.

## Timer State Machine

```
IDLE ──TIMER_START──► RUNNING ──TIMER_PAUSE──► PAUSED
  ▲                       │                       │
  │                   TIMER_STOP              TIMER_RESUME
  │                       ▼                       │
  └──(TIMER_RESET)── STOPPED ◄───────────────────┘
RUNNING ──[remaining ≤ 0]──► OVERTIME
OVERTIME ──TIMER_PAUSE──► PAUSED (then TIMER_RESUME → OVERTIME)
```

**Use `computeTimerValues(state)` from `timer.js`** to read elapsed/remaining/overtime — do not compute from state fields directly, as `slotStartedAt` is a `performance.now()` value that needs to be added to `slotElapsedMs` for the live total.

`performance.now()` is used for elapsed time (monotonic); `Date.now()` is used only for the wall-clock display and sync timestamps.

## WebRTC Message Protocol

All messages over DataChannel `"ept-control"` use this envelope:

```json
{ "v": 1, "type": "SYNC", "senderId": "<uuid>", "ts": 1746500000000, "payload": {} }
```

| Type | Direction | Notes |
|---|---|---|
| `SYNC` | controller → displays | Full state, every 2s and on transitions. **No `operatorNotes`** |
| `TICK_SYNC` | controller → displays | `{ timerState, serverWallClock }` every 500ms while running |
| `TIMER_START/PAUSE/RESUME/STOP/RESET` | controller → all | Timer commands |
| `SLOT_ADVANCE` | controller → all | `payload: { toIndex }` |
| `SCHEDULE_SET` | controller → all | `payload: { slots }` — no `operatorNotes` |
| `THRESHOLDS_SET` | controller → all | `payload: { thresholds: { yellowAt, redAt } }` |
| `MESSAGE_SET` | controller → all | `payload: { message }` |
| `MESSAGE_CLEAR` | controller → all | — |
| `THEME_SET` | any → all | `payload: { theme }` |
| `PEER_HELLO` | bidirectional on DC open | `payload: { role, displayName }` |

Signaling messages (`HELLO`, `OFFER`, `ANSWER`, `ICE`, `BYE`) go through the relay WebSocket only — never over DataChannel.

## Pairing Flow

`PairingManager` in `js/pairing.js` tries three methods in order:

1. **LAN relay**: `getLocalIPs()` → `subnetPeers()` → `discoverRelay()` probes `http://<ip>:7777/ping`. If found, connects WebSocket and uses relay for SDP exchange.
2. **QR code / join URL**: QR encodes `?join=<CODE>&role=display`. Display shows QR; controller scans and calls `joinByCode(code)`.
3. **Manual SDP**: `getManualOffer()` produces a base64 JSON blob containing the SDP offer. Paste into the other device's "Manual SDP" modal.

After DataChannel opens, `PeerManager` sends `PEER_HELLO` and (if controller) immediately sends a full `SYNC`.

## CSS Conventions

- All colours as CSS custom properties in `base.css` — no hardcoded hex values in component CSS
- Theme switching: `data-theme="dark|light"` on `<html>` — never add/remove a class for this
- Traffic light: CSS classes `traffic-green/yellow/red/overtime/idle` on `#display-bg` (display) and `#ctrl-countdown` (controller)
- Responsive sizing via `clamp()` — no media query breakpoints needed for the display screen

## Relay Server

Located in `relay/relay.js`. Depends only on `ws@8`.

```bash
cd relay && npm install && node relay.js [port]   # Default port: 7777
```

Endpoints:
- `GET /ping` → `{"relay": true, "version": 1}` — used by PWA for discovery
- `ws://` connections join a room by sending `HELLO { room, peerId }`, then exchange `OFFER/ANSWER/ICE` messages
- CORS headers are `*` on `/ping` so the PWA can probe from any origin

## Service Worker Cache-Busting

To force all users to get new files:
1. Change `CACHE_NAME = 'ept-v1'` to `'ept-v2'` (or any new name) in `sw.js`
2. Add any new files to `PRECACHE_URLS`
3. Deploy — the SW `activate` event deletes all old caches

## Cloudflare Pages Deployment

- Deploy the repo root as-is — no build command needed
- `_headers` sets `Cache-Control: no-cache` for `sw.js` and `manifest.webmanifest`
- Service Worker scope is `./` (relative to `index.html`) — no subpath issues
- The relay server runs separately (not on Cloudflare Pages)

## Security Notes

- `operatorNotes` is stripped in `timer.js::buildSyncPayload()` before any network transmission
- HTML strings rendered into `innerHTML` are escaped via `_esc()` in `controller.js`
- The relay server has no authentication — intended for LAN use only (document this clearly)
- No eval, no `innerHTML` from untrusted input, no external script dependencies

## CSV / JSON Import

**CSV** — columns: `Name, Title, Duration, Notes` (header optional, auto-detected)  
Duration: `MM:SS`, `H:MM:SS`, or plain number = minutes

**JSON** — array of objects:
```json
[{ "name": "...", "title": "...", "durationSec": 1200, "operatorNotes": "..." }]
```
Also accepts `duration` (string) and `notes` as aliases.

Both formats are handled by `parseSchedule(text)` in `js/schedule.js` which auto-detects format.

## Testing

**Local two-tab test** (no relay needed):
1. `python3 -m http.server 8080`
2. Open `http://localhost:8080/?role=controller` and `http://localhost:8080/?role=display`
3. Use **Pair device** → **Manual SDP**: copy offer from tab 1, paste as answer in tab 2, copy answer back
4. Verify schedule syncs, timer ticks on both tabs, traffic light colours change

**Two physical devices** (same LAN, with relay):
1. Run `cd relay && npm install && node relay.js` on one machine
2. Open the app on both devices
3. Verify auto-discovery connects them (no manual steps)

**Offline test**:
1. Install as PWA
2. Enable airplane mode
3. Reopen app — verify all views load from Service Worker cache
