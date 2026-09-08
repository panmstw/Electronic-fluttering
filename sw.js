const CACHE = 'piggy-cloud-v2-20260908-2';
const FILES = ['./','./index.html','./app.js','./ledger.js','./onedrive.js','./theme.js','./sync.css','./config.js','./vendor/msal.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
const allowed = new Set(FILES.map(path=>new URL(path,self.registration.scope).pathname));
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('piggy-cloud-')&&k!==CACHE).map(k=>caches.delete(k)))));
});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  // Never cache OAuth callbacks, Microsoft APIs, access tokens, or cloud ledger downloads.
  if (event.request.method!=='GET' || url.origin!==self.location.origin || url.search || !allowed.has(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async cache=>{
    try {
      const response=await fetch(event.request);
      if(response.ok) await cache.put(event.request,response.clone());
      return response;
    } catch(error) {
      const cached=await cache.match(event.request);
      if(cached) return cached;
      throw error;
    }
  }));
});
