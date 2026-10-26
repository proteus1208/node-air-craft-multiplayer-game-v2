# Air Plain Multiplayer

Minimal Node.js + React + WebSocket starter.

## Run locally

1. Install Node.js (LTS).
2. From this directory, run `npm install` once.
3. Run `npm run dev`.
4. Open the Vite URL printed in the terminal (usually `http://localhost:5173`).

The React client connects to `ws://localhost:3001`. Set `VITE_WEBSOCKET_URL` in a client `.env` file to use a different WebSocket URL.

## Project layout

- `server/src/` — WebSocket server and future game/room modules.
- `client/src/` — React interface and future game/network modules.
- `client/public/assets/` — place images, audio, and other static game assets here.
