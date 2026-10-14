// Logs every HTTP, WebSocket, TLS and UDP hit to /tmp/hits.log.
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');

const log = (message) => fs.appendFileSync('/tmp/hits.log', `${message}\n`);

const server = http.createServer((req, res) => {
  log(`HTTP ${req.method} ${req.url}`);
  res.end('secret');
});
server.on('upgrade', (req, socket) => {
  log(`UPGRADE ${req.url}`);
  socket.destroy();
});
server.on('connection', (socket) => {
  socket.once('data', (data) => {
    if (data[0] === 0x16) {
      log('TLS ClientHello');
    }
  });
});
server.listen(9999, '127.0.0.1');

const udp = dgram.createSocket('udp4');
udp.on('message', (message) => log(`UDP ${message.length}B`));
udp.bind(9998, '127.0.0.1');

log('READY');
