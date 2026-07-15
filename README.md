# ⚓ Shifting Seas

Battleship, but the ships won't sit still.

**Play now:** https://michaelplakiotis.github.io/shifting-seas/

## The twist

Classic Battleship rules — plus:

- **Ships move.** At the start of every turn, before you fire, you may move **one** ship a single square.
  - Ships of size 2+ can only slide **forward or backward** along their length.
  - The 1-square **Scout** can step in any orthogonal direction.
- **Rear hits immobilize.** Hit the tail of a ship and it can never move again.
- Damage travels with a ship when it moves. Old hit/miss markers stay pinned to the map — but the sea shifts, so a "miss" square might hold a ship next turn.
- **Powers** (spend your shot to use one):
  - 📡 **UAV** (every 5 turns) — sweep a row or column; enemy-occupied squares flash red. The intel goes stale as ships move.
  - 💥 **Triple shot** (every 6 turns) — fire 3 squares in a line at once.

## Fleet

Carrier (5) · Battleship (4) · Cruiser (3) · Submarine (2) · Scout (1) on a 10×10 grid.

## Game modes

- 🤝 **Pass & Play** — two players on one device, with hand-off screens.
- 🤖 **vs Computer** — hunt/target AI that also moves its ships and uses powers.
- 🌐 **Online** — peer-to-peer over [PeerJS](https://peerjs.com/). Create a room, share the 5-letter code, link, or **QR code**; the other player joins from anywhere. No server, no accounts.

Designed mobile-first: big touch targets, works great on phones, side-by-side boards on desktop.

## Tech

Plain HTML/CSS/JS, no build step. PeerJS (WebRTC) for online play, hosted on GitHub Pages.

## Run locally

Any static server works:

```
npx serve .
```

(Online mode needs `https://` or `localhost` for WebRTC.)
