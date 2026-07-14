var https = require('https');
var fs = require('fs');
var f = fs.readFileSync('C:/Users/Administrator/shared_site/image_proxy.js', 'utf8');
var key = f.substring(f.indexOf('MXAPI_KEY'), f.indexOf('\n', f.indexOf('MXAPI_KEY'))).match(/'([^']+)'/)[1];

var body = JSON.stringify({prompt:'保持主体不变，改成蓝色调',reference_images:['https://raw.githubusercontent.com/arg712730/arg712730.github.io/master/img/ref_05.png'],resolution:'1K'});
var req = https.request({hostname:'open.mxapi.org',path:'/api/v2/gpt-image-2',method:'POST',headers:{'Authorization':key,'Content-Type':'application/json'},rejectUnauthorized:false}, function(r){var d='';r.on('data',function(c){d+=c});r.on('end',function(){
  var j=JSON.parse(d);
  console.log('Submit:',j.code,j.message||'');
  if(j.code!==200) return;
  var tid=j.data.task_id;
  var c=0;
  (function poll(){if(c++>10){console.log('TIMEOUT');return;}setTimeout(function(){
  https.get('https://open.mxapi.org/api/v2/gpt-image/task?task_id='+tid,{headers:{'Authorization':key},rejectUnauthorized:false},function(r2){var d2='';r2.on('data',function(c){d2+=c});r2.on('end',function(){
    var j2=JSON.parse(d2);
    console.log('Poll '+c+': '+j2.data.status+(j2.data.error_msg?' '+j2.data.error_msg:''));
    if(j2.data.status==='completed'||j2.data.status==='failed') return;
    poll();
  })})},4000)})()
})});
req.write(body);req.end();
