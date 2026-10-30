/* The installed app always fetches account and workspace pages from the network.
 * Only the public offline notice and its public assets enter this cache. */
const CACHE='arios-public-shell-v1';
const OFFLINE='/offline.html';
const PUBLIC_FILES=[OFFLINE,'/offline.css','/assets/brand/app-icon-navy-gold-192.png'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>Promise.all(PUBLIC_FILES.map(path=>cache.add(new Request(path,{credentials:'omit',cache:'reload'}))))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('arios-public-shell-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||request.headers.has('authorization')||url.pathname==='/api'||url.pathname.startsWith('/api/'))return;
  if(PUBLIC_FILES.includes(url.pathname)&&!url.search){
    event.respondWith(fetch(request).catch(()=>caches.match(url.pathname,{cacheName:CACHE})));return;
  }
  // No API response, portal HTML, credential, session or user data is cached.
  if(request.mode==='navigate')event.respondWith(fetch(request).catch(async()=>{
    const offline=await caches.match(OFFLINE,{cacheName:CACHE});
    return offline||new Response('ارتباط اینترنت را بررسی و صفحه را دوباره باز کنید.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
  }));
});
