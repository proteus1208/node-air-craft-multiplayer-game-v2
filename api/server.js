import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { handleConnection } from '../server/src/index.js';

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('ok');
});

const sockets = new WebSocketServer({ server });
sockets.on('connection', handleConnection);

export default server;
