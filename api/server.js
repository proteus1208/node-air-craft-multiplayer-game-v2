import { upgradeWebSocket, experimental_upgradeWebSocket } from '@vercel/functions';
import { handleConnection } from '../server/src/index.js';

const upgrade = upgradeWebSocket || experimental_upgradeWebSocket;

export async function GET(request) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  return upgrade((socket) => {
    handleConnection(socket);
  });
}
