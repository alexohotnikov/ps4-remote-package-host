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

function serveFile(req, res, filePath, size) {
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416);
      return res.end();
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': 'application/octet-stream',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
  });
  fs.createReadStream(filePath).pipe(res);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, {
        root: rootDir,
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

    if (req.method === 'GET' && url.pathname.startsWith('/pkg/')) {
      const name = decodeURIComponent(url.pathname.slice('/pkg/'.length));
      const filePath = path.join(rootDir, name);
      if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath)) {
        return json(res, 404, { error: 'not found' });
      }
      return serveFile(req, res, filePath, fs.statSync(filePath).size);
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
