const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3458;
const HTML_FILE = path.join(__dirname, 'ai-canvas.html');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    return res.end();
  }

  // Image proxy: /proxy?url=xxx
  if (u.pathname === '/proxy') {
    const target = u.searchParams.get('url');
    if (!target) { res.writeHead(400); return res.end('missing url'); }
    try {
      const r = await fetch(target);
      if (!r.ok) { res.writeHead(502); return res.end('upstream error ' + r.status); }
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, {
        'Content-Type': r.headers.get('content-type') || 'image/png',
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(502);
      res.end('proxy error: ' + e.message);
    }
    return;
  }

  // Serve HTML
  try {
    const html = fs.readFileSync(HTML_FILE, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500);
    res.end('server error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('AI画布 + 图片代理: http://localhost:' + PORT);
  console.log('局域网: http://192.168.20.100:' + PORT);
});
