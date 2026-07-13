const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3458;
const MXAPI_KEY = '5s8NylrcJ0hJc28wlYCf3FGmI6bojMas';
const HTML_FILE = path.join(__dirname, 'ai-canvas.html');

// LiblibAI config
const LL_ACCESS = 'cdu_pJYbwtK4NysNbOBNbQ';
const LL_SECRET = 'VwQgP9c9eMeAObufTOg6oyh_nOhC6vPi';
const LL_BASE = 'https://openapi.liblibai.cloud';

// HMAC-SHA1 signature
function llSig(endpoint, ts, nonce) {
  return crypto.createHmac('sha1', LL_SECRET)
    .update(endpoint + '&' + ts + '&' + nonce)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function llApi(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const ts = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const s = llSig(endpoint, ts, nonce);
    const q = `AccessKey=${LL_ACCESS}&Signature=${encodeURIComponent(s)}&Timestamp=${ts}&SignatureNonce=${nonce}`;
    const url = new URL(endpoint + '?' + q, LL_BASE);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = { method, headers: { 'Content-Type': 'application/json' }, rejectUnauthorized: false };
    const req = https.request(url, opts, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { resolve(d); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// OSS upload
async function ossUpload(b64) {
  const ext = b64.match(/^data:image\/(\w+)/) ? b64.match(/^data:image\/(\w+)/)[1] : 'png';
  const name = 'outpaint_' + Date.now();
  const sigResp = await llApi('POST', '/api/generate/upload/signature', { name, extension: ext });
  if (!sigResp?.data) throw new Error('OSS signature failed');
  const sd = sigResp.data;

  const imgBuf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const ossRes = await new Promise((resolve, reject) => {
    const u = new URL(sd.url);
    const req = https.request(u, {
      method: 'PUT',
      headers: {
        'Content-Type': 'image/' + ext,
        'Content-Length': imgBuf.length,
        'x-oss-signature': sd.xOssSignature,
        'x-oss-date': sd.xOssDate,
        'x-oss-signature-version': sd.xOssSignatureVersion,
        'x-oss-credential': sd.xOssCredential,
        'x-oss-expires': String(sd.xOssExpires),
        'x-oss-security-token': sd.xOssSecurityToken || '',
      },
      rejectUnauthorized: false
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode === 200) resolve(sd.url); else reject(new Error('OSS ' + res.statusCode + ': ' + d.substring(0, 200))); });
    });
    req.on('error', reject);
    req.write(imgBuf);
    req.end();
  });

  return ossRes.split('?')[0];
}

// Submit img2img to LiblibAI
async function llImg2Img(sourceOssUrl, prompt, width, height, denoising) {
  const result = await llApi('POST', '/api/generate/webui/img2img', {
    templateUuid: '',
    generateParams: {
      prompt: prompt,
      width: Math.round(width),
      height: Math.round(height),
      steps: 20,
      cfgScale: 7,
      seed: -1,
      batchSize: 1,
      sourceImage: sourceOssUrl,
      resizedWidth: Math.round(width),
      resizedHeight: Math.round(height),
      denoisingStrength: denoising || 0.5,
    }
  });
  if (result.code !== 0 || !result.data?.generateUuid) throw new Error('img2img submit failed: ' + JSON.stringify(result));
  return result.data.generateUuid;
}

// Poll status
async function llPoll(uuid) {
  for (let i = 0; i < 60; i++) {
    const r = await llApi('POST', '/api/generate/webui/status', { generateUuid: uuid });
    if (r.code === 0 && r.data?.status === 'completed' && r.data?.images?.length) {
      return r.data.images[0].imageUrl;
    }
    if (r.data?.status === 'failed') throw new Error('Generation failed');
    await new Promise(ok => setTimeout(ok, 4000));
  }
  throw new Error('Timeout');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); return res.end();
  }

  const u = new URL(req.url, `http://localhost:${PORT}`);

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
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(buf);
    } catch (e) { res.writeHead(502); res.end('proxy error: ' + e.message); }
    return;
  }

  // Outpaint: POST /outpaint
  if (u.pathname === '/outpaint' && req.method === 'POST') {
    try {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          const { imageUrl, width, height, prompt, denoising } = params;
          if (!imageUrl || !width || !height) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing imageUrl/width/height' }));
          }

          console.log('[outpaint] Downloading original...');
          const imgResp = await fetch(imageUrl);
          const imgBuf = Buffer.from(await imgResp.arrayBuffer());
          const b64 = 'data:image/png;base64,' + imgBuf.toString('base64');

          console.log('[outpaint] Uploading to OSS...');
          const ossUrl = await ossUpload(b64);

          console.log('[outpaint] Submitting img2img', Math.round(width), 'x', Math.round(height));
          const uuid = await llImg2Img(ossUrl, prompt || 'seamlessly extend the image outward, maintaining content and style', width, height, denoising || 0.5);

          console.log('[outpaint] Polling', uuid);
          const resultUrl = await llPoll(uuid);

          console.log('[outpaint] Done:', resultUrl.substring(0, 80));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, url: resultUrl }));
        } catch (e) {
          console.error('[outpaint] Error:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve HTML
  try {
    var html = fs.readFileSync(HTML_FILE, 'utf8');
    html = html.replace(/__MXAPI_KEY__/g, MXAPI_KEY);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) { res.writeHead(500); res.end('server error'); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('AI画布 + 图片代理 + 扩图(LiblibAI): http://localhost:' + PORT);
});
