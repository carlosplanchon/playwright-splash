const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { parseNetworks, createGuard, startProxy } = require('../proxy');

describe('createGuard().isBlocked', () => {
  const guard = createGuard(parseNetworks(''));

  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.17.0.1',
    '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:a00:1::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1',
  ]) {
    it(`blocks ${address}`, () => assert.equal(guard.isBlocked(address), true));
  }

  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.215.14', '::ffff:8.8.8.8', '2606:4700:4700::1111']) {
    it(`allows ${address}`, () => assert.equal(guard.isBlocked(address), false));
  }

  it('lets allowed networks through, and only those', () => {
    const allowing = createGuard(parseNetworks('172.17.0.1, 10.0.0.0/8'));
    assert.equal(allowing.isBlocked('172.17.0.1'), false);
    assert.equal(allowing.isBlocked('::ffff:172.17.0.1'), false);
    assert.equal(allowing.isBlocked('10.200.0.1'), false);
    assert.equal(allowing.isBlocked('172.17.0.2'), true);
    assert.equal(allowing.isBlocked('127.0.0.1'), true);
  });
});

describe('parseNetworks', () => {
  for (const value of [undefined, '', '10.0.0.0/8', '10.0.0.0/8, 192.168.1.10', 'fd00::/8,::1', '0.0.0.0/0']) {
    it(`accepts ${JSON.stringify(value)}`, () => assert.doesNotThrow(() => parseNetworks(value)));
  }

  for (const value of ['foo', '10.0.0.0/', '10.0.0.0/33', '10.0.0.0/8/1', '10.0.0.0/-1', '10.0.0.0/8x', '300.1.1.1', '::1/129']) {
    it(`rejects ${JSON.stringify(value)}`, () => assert.throws(() => parseNetworks(value), /Invalid network/));
  }
});

describe('createGuard().lookup', () => {
  const lookup = (guard, hostname, options) => new Promise((resolve, reject) => {
    guard.lookup(hostname, options, (error, ...result) => (error ? reject(error) : resolve(result)));
  });

  it('refuses names that resolve to internal networks', async () => {
    await assert.rejects(lookup(createGuard(parseNetworks('')), 'localhost', {}), { code: 'ERR_INTERNAL_NETWORK' });
  });

  it('returns allowed addresses in both callback forms', async () => {
    const guard = createGuard(parseNetworks('127.0.0.0/8,::1'));
    const [address, family] = await lookup(guard, 'localhost', {});
    assert.ok(['127.0.0.1', '::1'].includes(address));
    assert.ok([4, 6].includes(family));
    const [addresses] = await lookup(guard, 'localhost', { all: true });
    assert.ok(addresses.length > 0 && addresses.every(({ address }) => ['127.0.0.1', '::1'].includes(address)));
  });
});

describe('createGuard().isInternalHost', () => {
  const guard = createGuard(parseNetworks(''));

  it('detects internal IP literals and names', async () => {
    assert.equal(await guard.isInternalHost('127.0.0.1'), true);
    assert.equal(await guard.isInternalHost('[::1]'), true);
    assert.equal(await guard.isInternalHost('localhost'), true);
    assert.equal(await guard.isInternalHost('8.8.8.8'), false);
  });

  it('respects allowed networks', async () => {
    assert.equal(await createGuard(parseNetworks('127.0.0.0/8,::1')).isInternalHost('localhost'), false);
  });
});

describe('startProxy', () => {
  let target;
  let targetPort;
  const received = [];
  const proxies = [];

  async function proxyWith(allowedNetworks) {
    const server = startProxy(createGuard(parseNetworks(allowedNetworks)), 0);
    proxies.push(server);
    if (!server.listening) {
      await once(server, 'listening');
    }
    return server.address().port;
  }

  function proxiedGet(proxyPort, url, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, path: url, headers: { host: new URL(url).host, ...headers } }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  function connect(proxyPort, authority) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority });
      req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket }));
      req.on('error', reject);
      req.end();
    });
  }

  before(async () => {
    target = http.createServer((req, res) => {
      received.push({ url: req.url, headers: req.headers });
      res.setHeader('Keep-Alive', 'timeout=99');
      res.setHeader('X-Target', 'yes');
      res.end('target says hi');
    });
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    targetPort = target.address().port;
  });

  after(() => {
    target.close();
    for (const server of proxies) {
      server.close();
    }
  });

  it('refuses plain HTTP to internal networks', async () => {
    const before = received.length;
    const res = await proxiedGet(await proxyWith(''), `http://127.0.0.1:${targetPort}/secret`);
    assert.equal(res.status, 403);
    assert.match(res.body, /internal network/);
    assert.equal(received.length, before);
  });

  it('refuses plain HTTP to names that resolve to internal networks', async () => {
    const before = received.length;
    const res = await proxiedGet(await proxyWith(''), `http://localhost:${targetPort}/secret`);
    assert.equal(res.status, 403);
    assert.equal(received.length, before);
  });

  it('forwards plain HTTP to allowed networks without hop-by-hop headers', async () => {
    const res = await proxiedGet(await proxyWith('127.0.0.1'), `http://127.0.0.1:${targetPort}/page?x=1`, {
      'Proxy-Connection': 'keep-alive',
      'Proxy-Authorization': 'Basic Zm9vOmJhcg==',
      'X-Custom': 'kept',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'target says hi');
    assert.equal(res.headers['x-target'], 'yes');
    assert.notEqual(res.headers['keep-alive'], 'timeout=99');
    const last = received.at(-1);
    assert.equal(last.url, '/page?x=1');
    assert.equal(last.headers['x-custom'], 'kept');
    assert.equal(last.headers['proxy-connection'], undefined);
    assert.equal(last.headers['proxy-authorization'], undefined);
  });

  it('rejects non-HTTP absolute URLs', async () => {
    const res = await proxiedGet(await proxyWith(''), 'ftp://example.com/file');
    assert.equal(res.status, 400);
  });

  it('refuses CONNECT to internal networks', async () => {
    const proxyPort = await proxyWith('');
    for (const authority of [`127.0.0.1:${targetPort}`, `[::1]:${targetPort}`, `localhost:${targetPort}`]) {
      const { status, socket } = await connect(proxyPort, authority);
      socket.destroy();
      assert.equal(status, 403, authority);
    }
  });

  it('rejects malformed CONNECT targets', async () => {
    const { status, socket } = await connect(await proxyWith(''), 'no-port');
    socket.destroy();
    assert.equal(status, 400);
  });

  it('tunnels CONNECT to allowed networks', async () => {
    const { status, socket } = await connect(await proxyWith('127.0.0.1'), `127.0.0.1:${targetPort}`);
    assert.equal(status, 200);
    socket.write(`GET /tunneled HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`);
    let response = '';
    for await (const chunk of socket) {
      response += chunk;
    }
    assert.match(response, /^HTTP\/1\.1 200/);
    assert.match(response, /target says hi/);
    assert.equal(received.at(-1).url, '/tunneled');
  });
});
