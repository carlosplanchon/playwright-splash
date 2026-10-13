const dns = require('dns');
const http = require('http');
const net = require('net');

// Ranges that scraped pages must never reach: "this network", private networks, CGNAT,
// loopback, link-local (cloud metadata), multicast, reserved and the IPv6 equivalents.
// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are matched against the IPv4 rules.
const internalNetworks = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) {
  internalNetworks.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2001::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) {
  internalNetworks.addSubnet(address, prefix, 'ipv6');
}

const hopByHopHeaders = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
];

// Parses a comma-separated list of addresses or CIDR ranges, e.g. "10.1.2.0/24,192.168.1.10".
function parseNetworks(value) {
  const networks = new net.BlockList();
  for (const entry of (value || '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const [address, prefix, ...rest] = entry.split('/');
    const type = net.isIPv4(address) ? 'ipv4' : net.isIPv6(address) ? 'ipv6' : null;
    const maxPrefix = type === 'ipv6' ? 128 : 32;
    const bits = prefix === undefined ? maxPrefix : /^\d+$/.test(prefix) ? Number(prefix) : NaN;
    if (!type || rest.length > 0 || !(bits >= 0 && bits <= maxPrefix)) {
      throw new Error(`Invalid network in SPLASH_ALLOWED_NETWORKS: ${entry}`);
    }
    networks.addSubnet(address, bits, type);
  }
  return networks;
}

function createGuard(allowedNetworks) {
  function isBlocked(address) {
    const type = net.isIPv6(address) ? 'ipv6' : 'ipv4';
    return internalNetworks.check(address, type) && !allowedNetworks.check(address, type);
  }

  // Drop-in replacement for dns.lookup() that never returns a blocked address, so every
  // connection goes to an address that was checked (there is no window for DNS rebinding).
  function lookup(hostname, options, callback) {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        return callback(error);
      }
      const allowed = addresses.filter(({ address }) => !isBlocked(address));
      if (allowed.length === 0) {
        const blocked = new Error(`${hostname} resolves to an internal network.`);
        blocked.code = 'ERR_INTERNAL_NETWORK';
        return callback(blocked);
      }
      if (options.all) {
        return callback(null, allowed);
      }
      callback(null, allowed[0].address, allowed[0].family);
    });
  }

  async function isInternalHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) {
      return isBlocked(host);
    }
    try {
      const addresses = await dns.promises.lookup(host, { all: true });
      return addresses.every(({ address }) => isBlocked(address));
    } catch (error) {
      // Let the browser report DNS errors.
      return false;
    }
  }

  return { isBlocked, lookup, isInternalHost };
}

function withoutHopByHopHeaders(headers) {
  const result = { ...headers };
  for (const name of hopByHopHeaders) {
    delete result[name];
  }
  return result;
}

// HTTP proxy for the browser. It forwards plain HTTP requests and tunnels everything else
// (HTTPS, WebSockets) with CONNECT, refusing any destination inside an internal network.
function startProxy(guard, port) {
  function isBlockedTarget(host) {
    if (net.isIP(host) && guard.isBlocked(host)) {
      console.log("-> Blocked request to an internal network:", host)
      return true;
    }
    return false;
  }

  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch (error) {
      return res.writeHead(400).end();
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (target.protocol !== 'http:') {
      return res.writeHead(400).end();
    }
    if (isBlockedTarget(host)) {
      return res.writeHead(403).end(`Blocked by playwright-splash: ${host} is in an internal network.`);
    }

    const upstream = http.request({
      host,
      port: target.port || 80,
      method: req.method,
      path: target.pathname + target.search,
      headers: withoutHopByHopHeaders(req.headers),
      lookup: guard.lookup,
      agent: false,
    }, (upstreamRes) => {
      upstreamRes.on('error', () => res.destroy());
      res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, withoutHopByHopHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });
    upstream.on('error', (error) => {
      if (res.headersSent) {
        return res.destroy();
      }
      if (error.code === 'ERR_INTERNAL_NETWORK') {
        console.log("-> Blocked request to an internal network:", host)
        return res.writeHead(403).end(`Blocked by playwright-splash: ${host} is in an internal network.`);
      }
      res.writeHead(502).end();
    });
    req.on('error', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    clientSocket.on('error', () => {});
    // The target is "host:port" or "[ipv6]:port".
    const match = /^\[?([^\]]+)\]?:(\d+)$/.exec(req.url);
    const host = match && match[1];
    const port = match && Number(match[2]);
    if (!match || port < 1 || port > 65535) {
      return clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
    if (isBlockedTarget(host)) {
      return clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }

    let connected = false;
    const upstream = net.connect({ host, port, lookup: guard.lookup }, () => {
      connected = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', (error) => {
      if (connected) {
        return clientSocket.destroy();
      }
      if (error.code === 'ERR_INTERNAL_NETWORK') {
        console.log("-> Blocked request to an internal network:", host)
        return clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      }
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('close', () => clientSocket.destroy());
  });

  server.on('error', (error) => {
    console.error("-> The proxy failed:", error.message)
    process.exit(1);
  });
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { parseNetworks, createGuard, startProxy };
