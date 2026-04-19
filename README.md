# Shadowquill VTT

A lightweight, single-page virtual tabletop for D&D and other tabletop RPGs. Built as a static web app with **no backend required** — real-time sync between DM and players runs peer-to-peer over WebRTC via PeerJS's free public broker.

Designed to be deployed on GitHub Pages in under two minutes.

---

## Features

- **Dual-mode interface** — separate DM (authoritative) and Player (restricted) views with strict permission asymmetry
- **Entity system** — PCs, Monsters, and NPCs with full D&D 5e stat blocks, HP/AC, ability scores, conditions, and notes
- **Hierarchical maps** — world → region → dungeon → room, with breadcrumb navigation and per-map viewport memory
- **Token visibility control** — DM reveals/hides individual tokens or entire maps; players only see what the DM allows
- **Drag & drop placement** — drag entities from the sidebar onto the map; DM drags to move, players move only their own PC
- **Initiative tracker** — auto-roll, manual override, turn advancement, tiebreak by initiative bonus then name
- **Encounter presets** — save & load map snapshots (token positions + visibility) for repeatable encounters
- **PC claiming** — players claim an available PC and can only move that token
- **Push-view** — DM force-locks players to a specific map mid-scene
- **Conditions** — 20 predefined D&D conditions, toggleable per entity with colored token dots
- **Export / import** — full session as JSON for backup or sharing
- **LocalStorage persistence** — auto-saves session and auth
- **Mobile-friendly** — touch drag, responsive layout, mobile panels
- **Dark fantasy aesthetic** — Cinzel + Cormorant Garamond serifs, gold accents on midnight blue, softly-glowing tokens

---

## Deploy to GitHub Pages (2 minutes)

1. Create a new repository on GitHub (e.g. `shadowquill-vtt`).
2. Copy the four files from this folder into the repo root:
   - `index.html`
   - `app.js`
   - `.nojekyll`
   - `README.md` (optional)
3. Commit and push to the `main` branch.
4. In the repo, go to **Settings → Pages**.
5. Under **Source**, choose **Deploy from a branch**.
6. Select `main` branch and `/ (root)` folder, then **Save**.
7. Wait ~30 seconds. Your site is live at `https://<your-username>.github.io/<repo-name>/`.

That's it. No build step, no npm, no server.

> The `.nojekyll` file tells GitHub Pages not to run Jekyll, which would otherwise ignore files starting with underscores and slow deploys.

---

## Usage

### Starting a session

**As DM:**
1. Open the site.
2. Click the **DM** tab.
3. Enter the DM password (default: `dragon` — see *Configuration* below).
4. Pick a room code (any string, e.g. `friday-night`) and click **Begin Session**.
5. Share the room code with your players.

**As a Player:**
1. Open the same URL.
2. Click the **Player** tab.
3. Enter your name and the room code the DM gave you.
4. Click **Join Session**.

**Local / offline mode:**
Click **Continue without sync** on the auth screen to run the app solo without connecting peers. Useful for prep, solo play, or when one person is screen-sharing.

### During a session

- **DM** builds maps (top bar → Maps → upload image), creates entities from the left sidebar, drags them onto the map, and reveals them when players encounter them.
- **Players** see only revealed tokens and their claimed PC. They drag their own PC to move.
- **Push view** (DM top bar) forces all players to view the current map — useful for dramatic scene transitions.
- **Presets** save the current token layout so encounters can be reloaded later.

---

## Configuration

### Changing the DM password

Open `app.js` and edit line 15:
```js
const DM_PASSWORD = 'dragon';
```
Change the string, commit, and redeploy. Note: this is a client-side check and is **not real security** — anyone can read the JS source. For a trusted group of players it's fine; for public-facing deployment, put the app behind a real auth layer.

### Changing the PeerJS broker

By default the app uses PeerJS's free public cloud broker at `0.peerjs.com`. If you need higher reliability or want to self-host, see [PeerJS server docs](https://github.com/peers/peerjs-server). You'd then pass config to `new Peer(...)` in `app.js` around line 303.

---

## How sync works

- DM is authoritative — the DM's browser holds the canonical game state.
- Players connect to the DM's peer via WebRTC (PeerJS handles signaling through its broker, then peers talk directly).
- Player actions (move my PC, claim a PC) are sent to the DM as messages; the DM validates, applies, and broadcasts filtered state back to each player individually — each player only receives the tokens they're allowed to see.
- Room codes map to peer IDs via the prefix `shadowquill-` to avoid collisions.

### Known limitations

- If the DM refreshes or closes the tab, players get disconnected and must rejoin.
- Very large map images (multi-MB PNGs) sync slowly because PeerJS chunks binary data inefficiently. Keep maps under ~2 MB for smooth joins. For heavy assets, host images externally and paste the URL instead of uploading.
- The public PeerJS broker occasionally rate-limits — if you can't connect, wait a minute and retry.
- No optimistic updates on the player side: there's a ~50–150 ms round-trip when moving your PC. Usually imperceptible.

---

## Local testing

You can't open `index.html` via `file://` because browsers block XHR fetches (Babel needs to fetch `app.js`). Use a local static server:

```bash
# Python 3
cd shadowquill-vtt
python -m http.server 8080
# then visit http://localhost:8080
```

Or any other static server (`npx serve`, `caddy file-server`, etc.).

---

## Tech stack

- **React 18** (loaded via CDN as UMD bundle — no build step)
- **Babel Standalone** transforms JSX in the browser
- **PeerJS** for WebRTC real-time sync
- Pure CSS with CSS custom properties for theming
- HTML5 drag-drop + pointer events for interactions
- LocalStorage for persistence

No bundler. No npm. No backend. Four files total.

---

## Security notes

- The DM password is a client-side placeholder; treat it as a "soft" gate, not real auth.
- WebRTC connections are peer-to-peer and encrypted in transit (DTLS), but the signaling broker sees connection metadata.
- Session state lives in LocalStorage on each user's device. Use Export/Import to back up.

---

## License

MIT — do what you want. Attribution appreciated but not required.
