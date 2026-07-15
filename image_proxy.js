const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3458;
const MXAPI_KEY = '5s8NylrcJ0hJc28wlYCf3FGmI6bojMas';
const HTML_FILE = path.join(__dirname, 'ai-canvas.html');
const REPO_DIR = __dirname;

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

const { execSync } = require('child_process');

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

// OSS upload (multipart POST with policy)
async function ossUpload(b64) {
  const ext = (b64.match(/^data:image\/(\w+)/) || [])[1] || 'png';
  const name = 'ref_' + Date.now();
  const sigResp = await llApi('POST', '/api/generate/upload/signature', { name, extension: ext });
  if (!sigResp?.data) throw new Error('OSS signature failed');
  const sd = sigResp.data;

  const imgBuf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const boundary = '----OSS' + Date.now() + Math.random().toString(36);
  
  // Build multipart body
  var parts = [];
  function addField(name, value) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n'));
  }
  addField('key', sd.key);
  addField('policy', sd.policy);
  addField('x-oss-signature', sd.xOssSignature);
  addField('x-oss-credential', sd.xOssCredential);
  addField('x-oss-date', sd.xOssDate);
  addField('x-oss-signature-version', sd.xOssSignatureVersion);
  if (sd.xOssSecurityToken) addField('x-oss-security-token', sd.xOssSecurityToken);
  // File part
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + name + '.' + ext + '"\r\nContent-Type: image/' + ext + '\r\n\r\n'));
  parts.push(imgBuf);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
  var body = Buffer.concat(parts);

  const resultUrl = await new Promise((resolve, reject) => {
    const u = new URL(sd.postUrl);
    const req = https.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length },
      rejectUnauthorized: false
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 204) resolve(sd.postUrl + '/' + sd.key);
        else reject(new Error('OSS ' + res.statusCode + ': ' + d.substring(0, 200)));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  return resultUrl;
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

  // Ollama vision proxy: POST /ollama-vision { image_b64 } → description text
  if (u.pathname === '/ollama-vision' && req.method === 'POST') {
    try {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { image_b64, lang } = JSON.parse(body);
          if (!image_b64) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing image_b64' })); }
          var prompts = { zh: 'Describe this image in Chinese (中文回答，不要英文). 用中文说明：1.内容 2.色调风格 3.氛围。', en: 'Describe this image briefly. Include: 1.main subject 2.style/color tones 3.mood/atmosphere.' };
          var prompt = prompts[lang] || prompts['zh'];
          var ollamaRes = await fetch('http://localhost:11434/api/generate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'granite3.2-vision:2b', prompt: prompt, images: [image_b64], stream: false })
          });
          var data = await ollamaRes.json();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, text: (data.response || '').trim() }));
        } catch(e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } catch(e) { res.writeHead(400); return res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // Upload ref image: POST /upload-ref { image: "data:image/..." }
  // Saves to GitHub Pages repo for a public URL MXAPI can access
  if (u.pathname === '/upload-ref' && req.method === 'POST') {
    try {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { image } = JSON.parse(body);
          if (!image || !image.startsWith('data:image/')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid image data' }));
          }
          const match = image.match(/^data:image\/(\w+);base64,(.+)$/);
          if (!match) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Bad data URL' })); }
          // Always use .png so filename is consistent (avoids ref_latest.png vs ref_latest.jpg mismatch)
          const ext = 'png';
          const buf = Buffer.from(match[2], 'base64');
          // Cycle through pre-cached filenames (ref_00.png - ref_09.png) for fast CDN updates
          var refIdx = (parseInt(fs.existsSync(path.join(REPO_DIR, 'img', '.ref_idx')) ? fs.readFileSync(path.join(REPO_DIR, 'img', '.ref_idx'), 'utf8').trim() : '0') || 0) % 10;
          fs.writeFileSync(path.join(REPO_DIR, 'img', '.ref_idx'), String(refIdx + 1));
          const fname = 'ref_' + String(refIdx).padStart(2, '0') + '.png';
          const imgDir = path.join(REPO_DIR, 'img');
          if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
          const fpath = path.join(imgDir, fname);
          fs.writeFileSync(fpath, buf);
          
          console.log('[upload-ref] Saved', fname, buf.length, 'bytes, pushing...');
          try {
            execSync('git add img/' + fname + ' && git commit -m "ref" && git push', { cwd: REPO_DIR, timeout: 15000, stdio: 'pipe' });
          } catch (e) {
            console.log('[upload-ref] Git note:', e.message.substring(0, 100));
          }
          const publicUrl = 'https://raw.githubusercontent.com/arg712730/arg712730.github.io/master/img/' + fname;
          console.log('[upload-ref] URL:', publicUrl);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, url: publicUrl }));
        } catch (e) {
          console.error('[upload-ref] Error:', e.message);
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

  // Img2img: POST /img2img { imageUrl, prompt, width, height, denoising }
  if (u.pathname === '/img2img' && req.method === 'POST') {
    try {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          const { imageUrl, prompt, width, height, denoising } = params;
          if (!imageUrl || !width || !height) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing imageUrl/width/height' }));
          }
          console.log('[img2img] Downloading source...');
          var resp = await fetch(imageUrl);
          var imgBuf = Buffer.from(await resp.arrayBuffer());
          const b64 = 'data:image/png;base64,' + imgBuf.toString('base64');

          console.log('[img2img] Uploading to OSS...');
          const ossUrl = await ossUpload(b64);

          console.log('[img2img] Submitting', Math.round(width), 'x', Math.round(height), 'denoising:', denoising);
          const uuid = await llImg2Img(ossUrl, prompt || '', width, height, denoising || 0.4);

          console.log('[img2img] Polling', uuid);
          const resultUrl = await llPoll(uuid);

          console.log('[img2img] Done:', resultUrl.substring(0, 80));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, url: resultUrl }));
        } catch (e) {
          console.error('[img2img] Error:', e.message);
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
          // Use https module for better reliability
          const imgBuf = await new Promise((resolve, reject) => {
            const getUrl = new URL(imageUrl);
            const mod = getUrl.protocol === 'https:' ? https : http;
            const getReq = mod.get(imageUrl, { rejectUnauthorized: false }, (getRes) => {
              if (getRes.statusCode >= 300 && getRes.statusCode < 400 && getRes.headers.location) {
                // Follow redirect
                const redirUrl = new URL(getRes.headers.location, imageUrl).href;
                const mod2 = redirUrl.startsWith('https') ? https : http;
                mod2.get(redirUrl, { rejectUnauthorized: false }, (r2) => {
                  const chunks = [];
                  r2.on('data', c => chunks.push(c));
                  r2.on('end', () => resolve(Buffer.concat(chunks)));
                }).on('error', reject);
                return;
              }
              const chunks = [];
              getRes.on('data', c => chunks.push(c));
              getRes.on('end', () => resolve(Buffer.concat(chunks)));
            });
            getReq.on('error', reject);
            getReq.setTimeout(30000, () => { getReq.destroy(); reject(new Error('Download timeout')); });
          });
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

  // Inpaint (local redraw): POST /inpaint { imageUrl, maskB64, prompt, width, height, denoising }
  if (u.pathname === '/inpaint' && req.method === 'POST') {
    try {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          const { imageUrl, maskB64, prompt, width, height, denoising } = params;
          if (!imageUrl || !maskB64 || !width || !height) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing imageUrl/maskB64/width/height' }));
          }

          console.log('[inpaint] Downloading original...');
          var resp = await fetch(imageUrl);
          var imgBuf = Buffer.from(await resp.arrayBuffer());
          const imgB64 = 'data:image/png;base64,' + imgBuf.toString('base64');

          console.log('[inpaint] Uploading original + mask to OSS...');
          const [ossImg, ossMask] = await Promise.all([ossUpload(imgB64), ossUpload(maskB64)]);

          const w = Math.round(width), h = Math.round(height);
          const promptText = prompt || 'seamlessly fill the marked area, match lighting and style';
          const denoise = denoising || 0.75;

          console.log('[inpaint] Submitting img2img with mask (w=' + w + ' h=' + h + ' denoise=' + denoise + ')');
          const genParams = {
            prompt: promptText,
            negativePrompt: 'blurry, low quality, distorted, bad anatomy',
            width: w, height: h,
            steps: 25, cfgScale: 7, seed: -1, batchSize: 1,
            sourceImage: ossImg,
            resizedWidth: w, resizedHeight: h,
            denoisingStrength: denoise,
            maskImage: ossMask,
            inpainting_fill: 1,
            inpaint_full_res: true,
            inpainting_mask_invert: 0
          };
          const r = await llApi('POST', '/api/generate/webui/img2img', { templateUuid: '', generateParams: genParams });
          if (r.code !== 0 || !r.data?.generateUuid) {
            const msg = 'img2img reject: code=' + r.code + ' msg=' + (r.msg || r.message || JSON.stringify(r).substring(0, 150));
            console.error('[inpaint] ' + msg);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: msg }));
          }
          console.log('[inpaint] Submitted:', r.data.generateUuid);
          const resultUrl = await llPoll(r.data.generateUuid);
          console.log('[inpaint] Done:', resultUrl.substring(0, 80));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, url: resultUrl }));
        } catch (e) {
          console.error('[inpaint] Error:', e.message);
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
