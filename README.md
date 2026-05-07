# Event Presentation Timer

An offline-capable presentation timer PWA. One controller manages the schedule and timer; multiple display screens show the countdown to speakers and the audience. Devices connect peer-to-peer over WebRTC — no cloud required after installation.

---

## Quick Start

1. Open the app URL on every device you want to use.
2. On the **stage screen / TV**: add `?role=display` to the URL (or use the "Open Display" home screen shortcut). The display will show a QR code and 6-character pairing code.
3. On the **controller** (default): click **Pair device**, scan the QR on the display or enter the code shown.
4. Add speakers to the schedule, hit **▶ Start**.

---

## Installation (PWA)

Install the app to your home screen so it works offline.

**iOS (Safari):** Tap the Share button → *Add to Home Screen*  
**Android (Chrome):** Tap the menu → *Install app* or tap the banner  
**Desktop (Chrome/Edge):** Click the install icon in the address bar

After installation, the app runs fully offline — no internet connection required.

---

## URL Parameters

| Parameter | Values | Description |
|-----------|--------|-------------|
| `?role=` | `controller` (default), `display`, `both` | Sets the device role |
| `?join=` | 6-char code | Auto-fills the pairing code on load |

Example: `https://your-app.pages.dev/?role=display`

---

## Controller Guide

### Timer Controls

| Button / Key | Action |
|---|---|
| **▶ Start** / `Space` | Start or resume the timer |
| **⏸ Pause** / `Space` | Pause the timer |
| **⏹ Stop** / `Esc` | Stop the timer |
| **↺ Reset** | Reset elapsed time for current slot |
| **⏭ Next** / `N` | Advance to next speaker slot |

### Traffic Light Thresholds

Set at the bottom of the timer section. Changes apply to all connected displays immediately.

- **Yellow warning**: seconds remaining when the screen turns yellow (default: 300 = 5 min)
- **Red warning**: seconds remaining when the screen turns red (default: 60 = 1 min)
- After 00:00: screen shows **overtime** (count-up with + prefix) and flashes briefly

### Schedule Management

- **+ Add speaker**: opens the speaker editor
- **✏ Edit / ✕ Delete / ↑↓ Reorder**: per-row buttons in the schedule table
- **Click a row**: jumps to that speaker slot
- **⬆ Import**: load a CSV or JSON file (see format below)
- **Operator notes**: private notes visible only in the controller — never sent to displays

### Sending Messages to Displays

Type a message in the *Message to Display* field and click **Send**. The message appears as an overlay on all connected displays until you click **Clear**.

---

## Display Guide

The display screen is designed to be visible from a distance.

| Element | Description |
|---|---|
| Large countdown | Time remaining (MM:SS), colour-coded by traffic light state |
| Speaker name / title | Current speaker's name and talk title |
| Next speaker | Shown when another slot follows |
| Wall clock | Current time (top left) |
| Planned end | When the current slot is scheduled to finish (top right) |
| Message overlay | Custom messages pushed from the controller |
| Flash | Screen flashes briefly when the timer reaches 00:00 |

When no controller is connected, the display shows a **QR code** and **pairing code** for a controller to scan.

---

## Pairing Options

### 1. LAN Auto-Discovery (requires relay server)

Start the relay server on any device on the same network. All devices discover it automatically and connect without any manual steps.

```bash
cd relay
npm install
node relay.js        # Listens on :7777
# Optional: node relay.js 8888   # Custom port
```

### 2. QR Code

The display screen shows a QR code. The controller scans it with the device camera (via **Pair device** → **QR Code** tab).

### 3. Manual Code

The display shows a 6-character code (e.g. `HQ7K2M`). The controller enters it via **Pair device** → **Enter Code**.

### 4. Manual SDP (last resort, fully offline)

For environments where even QR code exchange isn't possible. Use **Pair device** → **Manual SDP** to copy-paste WebRTC SDP blobs between devices.

---

## Import Formats

### CSV

```csv
Name,Title,Duration,Notes
Alice Smith,Opening Keynote,20:00,Check mic before slot
Bob Jones,Lightning Talk,05:00,
Carol White,Panel Discussion,30:00,Moderator: Dave
```

- **Duration**: `MM:SS`, `H:MM:SS`, or plain minutes (e.g. `20` = 20 minutes)
- **Header row**: optional — auto-detected
- **Notes**: imported as operator notes (private, not shown on display)

### JSON

```json
[
  { "name": "Alice Smith", "title": "Opening Keynote", "durationSec": 1200, "operatorNotes": "Check mic" },
  { "name": "Bob Jones",   "title": "Lightning Talk",  "durationSec": 300  }
]
```

Fields: `name` (required), `title`, `durationSec` or `duration` (MM:SS), `operatorNotes`/`notes`

---

## Many-to-Many Connections

Multiple controllers and multiple displays can all be connected simultaneously:

- **Multiple displays**: all show the same timer state — useful for a stage screen and a speaker confidence monitor
- **Multiple controllers**: all receive state updates; last-write-wins if two controllers send conflicting commands
- **Mixed role**: open `?role=both` to show both panels on one device (useful for a solo laptop setup)

---

## Architecture

```
Controller Browser  ←──WebRTC DataChannel──►  Display Browser(s)
        │                                              │
        └──────────── LAN Relay (optional) ────────────┘
                    ws://[local-ip]:7777
```

- **No internet required** for communication after install
- **WebRTC DataChannel** carries all timer state and commands
- **Relay** (optional Node.js script) enables auto-discovery on LAN
- **Service Worker** caches all assets for offline use
- **Operator notes** are never transmitted to displays

---

## Development

No build step. Serve with any static file server:

```bash
# Python
python3 -m http.server 8080

# Node.js
npx serve .
```

Then open:
- `http://localhost:8080/?role=controller` (controller tab)
- `http://localhost:8080/?role=display` (display tab)

For two-tab testing, use **Manual SDP** pairing (no relay needed for same-device testing).

---

## License

MIT — see [LICENSE](LICENSE)
