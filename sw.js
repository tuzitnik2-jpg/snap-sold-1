const CACHE='snap-sold-v1';
const SHELL=['/','/snap-sold-cz.html','/manifest.json','/icon.svg'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(url.pathname.startsWith('/api/')) return; // never cache API/auth calls
  if(e.request.method!=='GET') return;
  e.respondWith(
    caches.match(e.request).then(cached=>{
      const network=fetch(e.request).then(res=>{
        if(res && res.ok) caches.open(CACHE).then(c=>c.put(e.request,res.clone()));
        return res;
      }).catch(()=>cached);
      return cached || network;
    })
  );
});
