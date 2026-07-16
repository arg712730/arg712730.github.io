// wash_flow_remote.js - FLUX wash tool (remote-friendly)
// PROXY auto-detects: uses current page origin for tunnel access, falls back to localhost
var PROXY = (function() {
  // If accessed via tunnel/GitHub Pages, use origin
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    var origin = window.location.origin;
    // localhost/127.0.0.1 should still use origin (proxy serves locally too)
    return origin;
  }
  return 'http://localhost:9876';
})();
var TEMPLATE = '63b72710c9574457ba303d9d9b8df8bd';
var LORA = '5b5b759ebb02415795c565061f1a4f68';
var selectedFile = null;
var originalDataUrl = null;

function log(msg) {
  var l = document.getElementById('log');
  l.innerHTML += '<br>[' + new Date().toLocaleTimeString() + '] ' + msg;
  l.scrollTop = l.scrollHeight;
}

function showError(msg) {
  document.getElementById('error').textContent = 'ERROR: ' + msg;
  setTimeout(function() { document.getElementById('error').textContent = ''; }, 10000);
}

// Sliders
document.getElementById('denoise').oninput = function() {
  document.getElementById('denoiseVal').textContent = this.value;
};
document.getElementById('steps').oninput = function() {
  document.getElementById('stepsVal').textContent = this.value;
};
document.getElementById('lora').oninput = function() {
  document.getElementById('loraVal').textContent = this.value;
};

// File selection
document.getElementById('file').onchange = function() {
  var f = this.files[0];
  if (!f) return;
  if (!f.type.match(/image\/(jpeg|png)/)) { showError('请选 JPG/PNG'); return; }
  if (f.size > 10*1024*1024) { showError('图太大 (>10MB)'); return; }
  selectedFile = f;
  var reader = new FileReader();
  reader.onload = function(e) {
    originalDataUrl = e.target.result;
    var p = document.getElementById('preview');
    p.src = originalDataUrl;
    p.style.display = 'block';
    document.getElementById('btn').disabled = false;
  };
  reader.readAsDataURL(f);
};

// Main button
document.getElementById('btn').onclick = async function() {
  if (!selectedFile) return;
  var btn = document.getElementById('btn');
  btn.disabled = true;
  btn.textContent = '处理中...';
  document.getElementById('loading').style.display = 'block';
  document.getElementById('result').style.display = 'none';
  document.getElementById('error').textContent = '';
  document.getElementById('log').innerHTML = '';
  log('开始洗图...');
  log('服务: ' + PROXY);
  
  var start = Date.now();
  var timer = setInterval(function() {
    document.getElementById('timer').textContent = Math.floor((Date.now() - start) / 1000) + 's';
  }, 1000);
  
  try {
    // Step 1: Upload signature
    log('1/4 获取上传签名...');
    var sigRes = await fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiPath: '/api/generate/upload/signature',
        apiBody: { name: selectedFile.name, extension: 'png' }
      })
    });
    var sig = await sigRes.json();
    if (sig.code !== 0) throw new Error('签名失败: ' + (sig.msg || sig.code));
    log('  签名 OK');
    
    // Step 2: Upload to OSS
    log('2/4 上传到 OSS...');
    var fd = new FormData();
    fd.append('key', sig.data.key);
    fd.append('policy', sig.data.policy);
    fd.append('x-oss-signature-version', sig.data.xOssSignatureVersion);
    fd.append('x-oss-credential', sig.data.xOssCredential);
    fd.append('x-oss-date', sig.data.xOssDate);
    fd.append('x-oss-signature', sig.data.xOssSignature);
    fd.append('file', selectedFile, selectedFile.name);
    
    var ossRes = await fetch(sig.data.postUrl, { method: 'POST', body: fd });
    if (!ossRes.ok && ossRes.status !== 204) throw new Error('OSS上传失败 HTTP ' + ossRes.status);
    var imgUrl = 'https://liblibai-airship-temp.oss-cn-beijing.aliyuncs.com/' + sig.data.key;
    log('  OSS 上传完成');
    
    // Step 3: Submit img2img
    var den = parseFloat(document.getElementById('denoise').value);
    var step = parseInt(document.getElementById('steps').value);
    var lw = parseFloat(document.getElementById('lora').value);
    log('3/4 提交 AI 生成 (降噪:' + den + ' 步数:' + step + ' LoRA:' + lw + ')');
    
    var genRes = await fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiPath: '/api/generate/webui/img2img',
        apiBody: {
          templateUuid: TEMPLATE,
          generateParams: {
            prompt: 'high quality, masterpiece, best quality, finely detail, highres, 8k, no watermark, professional photography',
            steps: step, seed: -1, imgCount: 1, restoreFaces: 0,
            sourceImage: imgUrl, resizeMode: 1, mode: 0,
            denoisingStrength: den, resizedWidth: 1024, resizedHeight: 1024,
            additionalNetwork: [{ modelId: LORA, weight: lw }]
          }
        }
      })
    });
    var gen = await genRes.json();
    if (gen.code !== 0) throw new Error('提交失败: ' + (gen.msg || gen.code));
    var genUuid = gen.data.generateUuid;
    log('  任务ID: ' + genUuid.slice(0, 8));
    
    // Step 4: Poll for result
    log('4/4 等待生成...');
    for (var i = 0; i < 120; i++) {
      await new Promise(function(r) { setTimeout(r, 4000); });
      var stRes = await fetch(PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiPath: '/api/generate/status',
          apiBody: { generateUuid: genUuid }
        })
      });
      var st = await stRes.json();
      if (st.code !== 0) continue;
      if (st.data.generateStatus === 5) {
        var imgs = st.data.images;
        if (imgs && imgs[0] && imgs[0].imageUrl) {
          clearInterval(timer);
          document.getElementById('loading').style.display = 'none';
          document.getElementById('result').style.display = 'block';
          document.getElementById('origImg').src = originalDataUrl;
          document.getElementById('washImg').src = imgs[0].imageUrl;
          document.getElementById('cost').textContent = st.data.pointsCost + ' 积分';
          document.getElementById('bal').textContent = st.data.accountBalance + ' 积分';
          document.getElementById('time').textContent = Math.round((Date.now() - start) / 1000) + 's';
          document.getElementById('dl').href = imgs[0].imageUrl;
          log('✅ 完成! 消耗' + st.data.pointsCost + '积分 剩余' + st.data.accountBalance);
          btn.disabled = false;
          btn.textContent = '🧼 开始洗图';
          return;
        }
      }
      if (st.data.generateStatus === -1 || st.data.generateStatus === 3) {
        throw new Error('生成失败: ' + (st.data.generateMsg || '审核'));
      }
      if (i === 3) log('  FLUX 模型加载中...');
      if (i % 15 === 0 && i > 0) log('  ' + Math.round((Date.now() - start) / 1000) + 's...');
    }
    throw new Error('超时');
  } catch(e) {
    clearInterval(timer);
    document.getElementById('loading').style.display = 'none';
    log('❌ ' + e.message);
    showError(e.message);
    btn.disabled = false;
    btn.textContent = '🧼 开始洗图';
  }
};
