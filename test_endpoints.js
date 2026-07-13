var key='5s8NylrcJ0hJc28wlYCf3FGmI6bojMas';
var h={'Authorization':key,'Content-Type':'application/json'};
var eps=[
  '/api/v2/img2img',
  '/api/v2/gpt-image-2/img2img',
  '/api/v2/nano-pro/img2img',
  '/api/v2/outpaint',
  '/api/v2/gpt-image-2',
  '/api/v2/nano-pro'
];

async function test() {
  for (var ep of eps) {
    try {
      var r = await fetch('https://open.mxapi.org'+ep, {
        method:'POST', headers:h,
        body:JSON.stringify({prompt:'test',reference_images:['https://example.com/test.png']})
      });
      var d = await r.json();
      console.log(ep + ': ' + r.status + ' ' + JSON.stringify(d).substring(0,150));
    } catch(e) {
      console.log(ep + ': ERR ' + e.message);
    }
  }
}
test();
