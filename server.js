#!/usr/bin/env node
// Локальный сендер для Remote Package Installer (RPI by Zer0xFF) на PS4.
// Раздаёт PKG по HTTP с мака и шлёт команду установки на PS4 (TCP :9090).
// Запуск: node server.js <папка с pkg> [порт]

const http = require('http');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const rootDir = path.resolve(argv[0] || '.');
const port = Number(argv[1]) || 8000;
const PS4_RPI_PORT = 9090;

if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
  console.error(`Папка не найдена: ${rootDir}`);
  process.exit(1);
}

function lanIPs() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function listPkgs() {
  return fs
    .readdirSync(rootDir)
    .filter((f) => f.toLowerCase().endsWith('.pkg'))
    .map((name) => {
      const st = fs.statSync(path.join(rootDir, name));
      return { name, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function resolvePkg(name) {
  if (!name || name !== path.basename(name) || !name.toLowerCase().endsWith('.pkg')) return null;
  const filePath = path.join(rootDir, name);
  try {
    const st = fs.statSync(filePath);
    return st.isFile() ? { filePath, size: st.size } : null;
  } catch {
    return null;
  }
}

function pipeFile(res, filePath, opts) {
  const stream = fs.createReadStream(filePath, opts);
  stream.on('error', (e) => {
    console.error(`read error ${filePath}: ${e.message}`);
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (!m[1]) {
    start = Math.max(0, size - parseInt(m[2], 10));
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
  }
  return start < size && start <= end ? { start, end } : null;
}

function serveFile(req, res, filePath, size) {
  const headOnly = req.method === 'HEAD';
  const base = {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
  };
  if (req.headers.range) {
    const r = parseRange(req.headers.range, size);
    if (!r) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${r.start}-${r.end}/${size}`,
      'Content-Length': r.end - r.start + 1,
    });
    return headOnly ? res.end() : pipeFile(res, filePath, r);
  }
  res.writeHead(200, {
    ...base,
    'Content-Length': size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
  });
  return headOnly ? res.end() : pipeFile(res, filePath);
}

// Протокол RPI: JSON {"method":"activate","params":{"url":"http://..."}} в сокет.
// После команды RPI может слать события в тот же сокет — собираем их в лог.
function rpiSend(ip, payload, onEvent) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: ip, port: PS4_RPI_PORT });
    const events = [];
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      err ? reject(err) : resolve(events);
    };
    sock.setTimeout(3000);
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload));
      sock.setTimeout(9000);
    });
    sock.on('data', (d) => {
      events.push(d.toString('utf8').trim());
      onEvent && onEvent(d.toString('utf8').trim());
    });
    sock.on('error', finish);
    sock.on('timeout', () => finish());
    sock.on('close', () => finish());
  });
}

function rpiPing(ip) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: ip, port: PS4_RPI_PORT });
    s.setTimeout(1500);
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

// Морда слушает 0.0.0.0, поэтому /api закрыт от CSRF и DNS-rebinding:
// чужой сайт в браузере мака не должен уметь слать команды на PS4.
function apiAllowed(req) {
  const allowedHosts = new Set(['localhost', '127.0.0.1', ...lanIPs()].map((h) => `${h}:${port}`));
  if (!allowedHosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  if (req.method === 'POST' && !/^application\/json\b/.test(req.headers['content-type'] || '')) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/api/') && !apiAllowed(req)) {
      return json(res, 403, { error: 'forbidden' });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, {
        root: rootDir,
        port,
        ips: lanIPs(),
        files: listPkgs(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/ping') {
      const ip = url.searchParams.get('ip');
      if (!ip) return json(res, 400, { error: 'no ip' });
      const ok = await rpiPing(ip);
      return json(res, 200, { ok });
    }

    if (req.method === 'POST' && url.pathname === '/api/send') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const ip = body.ip;
      if (!ip) return json(res, 400, { error: 'no ip' });
      let payload;
      if (body.rawJson) {
        payload = JSON.parse(body.rawJson);
      } else {
        if (!body.url) return json(res, 400, { error: 'no url' });
        payload = { method: 'activate', params: { url: body.url } };
      }
      const events = await rpiSend(ip, payload);
      return json(res, 200, { ok: true, events });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/pkg/')) {
      const pkg = resolvePkg(decodeURIComponent(url.pathname.slice('/pkg/'.length)));
      if (!pkg) return json(res, 404, { error: 'not found' });
      console.log(`${req.method} ${path.basename(pkg.filePath)} ← ${req.socket.remoteAddress}${req.headers.range ? ` (${req.headers.range})` : ''}`);
      return serveFile(req, res, pkg.filePath, pkg.size);
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    json(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(port, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log(`PKG folder : ${rootDir}`);
  console.log(`Web UI     : http://localhost:${port}`);
  ips.forEach((ip) => console.log(`Web UI (LAN): http://${ip}:${port}`));
  console.log(`PS4 target : RPI port ${PS4_RPI_PORT} (в приложении на PS4 должен быть запущен RPI)`);
});
