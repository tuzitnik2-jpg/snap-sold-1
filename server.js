'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const USERS_FILE = path.join(__dirname, 'users.json');
const SECRET_FILE = path.join(__dirname, '.session-secret');

/* ---------- session secret (persisted so logins survive restart) ---------- */
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {}
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); try { fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); } catch {} }
}

/* ---------- user store (flat JSON file) ---------- */
function loadUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; } }
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2), { mode: 0o600 }); }

function hashPw(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }

/* ---------- signed session cookie ---------- */
function sign(email) {
  const b = Buffer.from(email).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(b).digest('hex');
  return b + '.' + mac;
}
function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [b, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(b).digest('hex');
  const a = Buffer.from(mac || '', 'hex'), e = Buffer.from(expect, 'hex');
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
  try { return Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
}
function parseCookies(req) {
  const out = {}; const c = req.headers.cookie;
  if (c) c.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function sessionEmail(req) { return verify(parseCookies(req).sess); }
function setSession(res, email) {
  res.setHeader('Set-Cookie', `sess=${sign(email)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
}
function clearSession(res) { res.setHeader('Set-Cookie', 'sess=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'); }

/* ---------- helpers ---------- */
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 20_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- rate limiting (in-memory sliding window) ---------- */
const rateBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  rateBuckets.set(key, arr);
  return arr.length > max;
}
function clientIp(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, arr] of rateBuckets) { const f = arr.filter(t => t > cutoff); if (f.length) rateBuckets.set(k, f); else rateBuckets.delete(k); }
}, 10 * 60 * 1000).unref();

/* ---------- password reset / email verify tokens (in-memory; no SMTP configured) ---------- */
const resetTokens = new Map();
const verifyTokens = new Map();
function makeToken() { return crypto.randomBytes(24).toString('hex'); }

/* ---------- auth endpoints ---------- */
async function handleSignup(req, res) {
  if (rateLimited('signup:' + clientIp(req), 6, 60 * 60 * 1000)) return json(res, 429, { error: 'Příliš mnoho pokusů o registraci. Zkus to později.' });
  let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'Neplatný požadavek' }); }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Neplatný e-mail' });
  if (password.length < 8) return json(res, 400, { error: 'Heslo musí mít aspoň 8 znaků' });
  const users = loadUsers();
  if (users[email]) return json(res, 409, { error: 'Účet s tímto e-mailem už existuje' });
  const salt = makeSalt();
  users[email] = { salt, hash: hashPw(password, salt), created: Date.now(), verified: false };
  saveUsers(users);
  setSession(res, email);
  const token = makeToken();
  verifyTokens.set(token, { email, expires: Date.now() + 60 * 60 * 1000 });
  json(res, 200, { email, verifyLink: '/api/verify-email?token=' + token, verifyNote: 'Žádný e-mail server není nastaven — v produkci by se tento odkaz poslal na e-mail. Teď si ho můžeš rovnou otevřít.' });
}
async function handleLogin(req, res) {
  const email0 = clientIp(req);
  if (rateLimited('login:' + email0, 10, 5 * 60 * 1000)) return json(res, 429, { error: 'Příliš mnoho pokusů o přihlášení. Zkus to za pár minut.' });
  let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'Neplatný požadavek' }); }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const users = loadUsers();
  const u = users[email];
  const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
  if (!ok) return json(res, 401, { error: 'Nesprávný e-mail nebo heslo' });
  setSession(res, email);
  json(res, 200, { email, verified: !!u.verified });
}
async function handleForgotPassword(req, res) {
  if (rateLimited('forgot:' + clientIp(req), 5, 60 * 60 * 1000)) return json(res, 429, { error: 'Příliš mnoho pokusů. Zkus to později.' });
  let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'Neplatný požadavek' }); }
  const email = String(body.email || '').trim().toLowerCase();
  const users = loadUsers();
  if (!users[email]) return json(res, 200, { ok: true });
  const token = makeToken();
  resetTokens.set(token, { email, expires: Date.now() + 30 * 60 * 1000 });
  json(res, 200, { ok: true, resetLink: '/?resetToken=' + token, note: 'Žádný e-mail server není nastaven — v produkci by se tento odkaz poslal e-mailem. Teď si ho můžeš rovnou otevřít.' });
}
async function handleResetPassword(req, res) {
  let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'Neplatný požadavek' }); }
  const token = String(body.token || ''), password = String(body.password || '');
  const rec = resetTokens.get(token);
  if (!rec || rec.expires < Date.now()) return json(res, 400, { error: 'Odkaz je neplatný nebo vypršel' });
  if (password.length < 8) return json(res, 400, { error: 'Heslo musí mít aspoň 8 znaků' });
  const users = loadUsers();
  if (!users[rec.email]) return json(res, 400, { error: 'Účet neexistuje' });
  const salt = makeSalt();
  users[rec.email] = { ...users[rec.email], salt, hash: hashPw(password, salt) };
  saveUsers(users);
  resetTokens.delete(token);
  setSession(res, rec.email);
  json(res, 200, { email: rec.email });
}
async function handleRequestVerify(req, res) {
  const email = sessionEmail(req); if (!email) return json(res, 401, { error: 'Nepřihlášeno' });
  if (rateLimited('verify:' + email, 5, 60 * 60 * 1000)) return json(res, 429, { error: 'Příliš mnoho pokusů. Zkus to později.' });
  const token = makeToken();
  verifyTokens.set(token, { email, expires: Date.now() + 60 * 60 * 1000 });
  json(res, 200, { verifyLink: '/api/verify-email?token=' + token, note: 'Žádný e-mail server není nastaven — v produkci by se tento odkaz poslal e-mailem.' });
}
function handleVerifyEmail(req, res, urlObj) {
  const token = urlObj.searchParams.get('token');
  const rec = verifyTokens.get(token);
  res.writeHead(rec && rec.expires >= Date.now() ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
  if (!rec || rec.expires < Date.now()) { res.end('<body style="font-family:sans-serif;padding:40px">Odkaz je neplatný nebo vypršel.</body>'); return; }
  const users = loadUsers();
  if (users[rec.email]) { users[rec.email].verified = true; saveUsers(users); }
  verifyTokens.delete(token);
  res.end('<body style="font-family:sans-serif;padding:40px"><h2>E-mail ověřen ✓</h2><p>Můžeš zavřít tuto stránku a vrátit se do aplikace.</p></body>');
}

/* ---------- vision proxy (Anthropic, key supplied by client per request) ---------- */
function proxyVision(req, res) {
  const key = req.headers['x-user-key'];
  if (!key) return json(res, 400, { error: 'Chybí API klíč — vlož ho v Nastavení.' });
  let body = '';
  req.on('data', c => { body += c; if (body.length > 20_000_000) req.destroy(); });
  req.on('end', () => {
    const up = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    }, upRes => { res.writeHead(upRes.statusCode, { 'Content-Type': 'application/json' }); upRes.pipe(res); });
    up.on('error', e => json(res, 502, { error: 'Upstream selhal: ' + e.message }));
    up.end(body);
  });
}

/* ---------- vision proxy (Gemini, key supplied by client per request) ---------- */
function proxyVisionGemini(req, res) {
  const key = req.headers['x-user-key'];
  if (!key) return json(res, 400, { error: 'Chybí Gemini API klíč — vlož ho v Nastavení.' });
  readBody(req).then(body => {
    const images = Array.isArray(body.images) ? body.images : [];
    const prompt = body.prompt || '';
    if (!images.length || !prompt) return json(res, 400, { error: 'Očekávám {images:[base64,...], prompt:"..."}' });

    const parts = images.map(b64 => ({ inline_data: { mime_type: 'image/jpeg', data: b64 } }));
    parts.push({ text: prompt });
    const model = 'gemini-3.5-flash'; // uprav, pokud vyjde novější Flash model
    const payload = JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });

    const up = https.request(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      upRes => {
        let d = ''; upRes.on('data', c => d += c);
        upRes.on('end', () => {
          if (upRes.statusCode >= 400) return json(res, upRes.statusCode, { error: 'Gemini API chyba: ' + d.slice(0, 300) });
          try {
            const parsed = JSON.parse(d);
            const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (!text) return json(res, 502, { error: 'Gemini nevrátil žádný text' });
            json(res, 200, { text });
          } catch { json(res, 502, { error: 'Gemini vrátil neplatná data' }); }
        });
      }
    );
    up.on('error', e => json(res, 502, { error: 'Upstream selhal: ' + e.message }));
    up.end(payload);
  }).catch(() => json(res, 400, { error: 'Neplatný požadavek' }));
}

/* ---------- local vision proxy (Ollama, no key, no cost) ---------- */
function proxyVisionLocal(req, res) {
  readBody(req).then(body => {
    const payload = JSON.stringify({
      model: body.model || 'llava',
      prompt: body.prompt || '',
      images: Array.isArray(body.images) ? body.images : [],
      stream: false,
      format: 'json'
    });
    const base = process.env.OLLAMA_URL || 'http://localhost:11434';
    let u; try { u = new URL('/api/generate', base); } catch { return json(res, 500, { error: 'Neplatná OLLAMA_URL' }); }
    const up = http.request({
      method: 'POST', hostname: u.hostname, port: u.port || 11434, path: u.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, upRes => {
      let d = ''; upRes.on('data', c => d += c);
      upRes.on('end', () => {
        if (upRes.statusCode >= 400) return json(res, 502, { error: 'Ollama chyba ' + upRes.statusCode + ': ' + d.slice(0, 200) });
        try { json(res, 200, { response: JSON.parse(d).response || '' }); }
        catch { json(res, 502, { error: 'Ollama vrátil neplatná data' }); }
      });
    });
    up.on('error', e => json(res, 502, { error: 'Ollama nedostupný (' + e.code + '). Spusť `ollama serve` a stáhni model: `ollama pull llava`.' }));
    up.end(payload);
  }).catch(() => json(res, 400, { error: 'Neplatný požadavek' }));
}

/* ---------- per-user data stores (quick-list, saved listings, synced prefs) ---------- */
const QUICKLIST_FILE = path.join(__dirname, 'quicklist.json');
const LISTINGS_FILE = path.join(__dirname, 'listings.json');
const PREFS_FILE = path.join(__dirname, 'prefs.json');
const PROTECTED_FILES = new Set(['users.json', '.session-secret', 'quicklist.json', 'listings.json', 'prefs.json']);

function loadJSONFile(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }
function saveJSONFile(f, obj) { fs.writeFileSync(f, JSON.stringify(obj, null, 2), { mode: 0o600 }); }

async function handleListGet(req, res, file) {
  const email = sessionEmail(req); if (!email) return json(res, 401, { error: 'Nepřihlášeno' });
  const store = loadJSONFile(file);
  json(res, 200, { items: store[email] || [] });
}
async function handleListAdd(req, res, file) {
  const email = sessionEmail(req); if (!email) return json(res, 401, { error: 'Nepřihlášeno' });
  let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'Neplatný požadavek' }); }
  const store = loadJSONFile(file);
  if (!store[email]) store[email] = [];
  const item = { ...body.item, id: crypto.randomUUID(), created: Date.now() };
  store[email].unshift(item);
  if (store[email].length > 500) store[email] = store[email].slice(0, 500);
  saveJSONFile(file, store);
  json(res, 200, { item });
}
async function handleListDelete(req, res, file) {
  const email = sessionEmail(req); if (!email) return json(res, 401, { error: 'Nepřihlášeno' });
  let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'Neplatný požadavek' }); }
  const store = loadJSONFile(file);
  store[email] = (store[email] || []).filter(it => it.id !== body.id);
  saveJSONFile(file, store);
  json(res, 200, { ok: true });
}
async function handlePrefsGet(req, res) {
  const email = sessionEmail(req); if (!email) return json(res, 401, { error: 'Nepřihlášeno' });
  const store = loadJSONFile(PREFS_FILE);
  json(res, 200, { prefs: store[email] || {} });
}
async function handlePrefsSave(req, res) {
  const email = sessionEmail(req); if (!email) return json(res, 401, { error: 'Nepřihlášeno' });
  let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'Neplatný požadavek' }); }
  const store = loadJSONFile(PREFS_FILE);
  store[email] = { ...(store[email] || {}), ...(body.prefs || {}) };
  saveJSONFile(PREFS_FILE, store);
  json(res, 200, { prefs: store[email] });
}

/* ---------- static ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
function serveStatic(req, res) {
  const rel = req.url === '/' ? '/snap-sold-cz.html' : req.url.split('?')[0];
  const full = path.join(__dirname, rel);
  if (!full.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (PROTECTED_FILES.has(path.basename(full))) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (req.method === 'GET' && u === '/api/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && u === '/api/signup') return handleSignup(req, res);
  if (req.method === 'POST' && u === '/api/login') return handleLogin(req, res);
  if (req.method === 'POST' && u === '/api/logout') { clearSession(res); return json(res, 200, { ok: true }); }
  if (req.method === 'GET' && u === '/api/me') {
    const e = sessionEmail(req); if (!e) return json(res, 401, { error: 'Nepřihlášeno' });
    const users = loadUsers(); return json(res, 200, { email: e, verified: !!(users[e] && users[e].verified) });
  }
  if (req.method === 'POST' && u === '/api/forgot-password') return handleForgotPassword(req, res);
  if (req.method === 'POST' && u === '/api/reset-password') return handleResetPassword(req, res);
  if (req.method === 'POST' && u === '/api/request-verify') return handleRequestVerify(req, res);
  if (req.method === 'GET' && u === '/api/verify-email') return handleVerifyEmail(req, res, new URL(req.url, 'http://x'));
  if (req.method === 'POST' && u === '/api/vision') return proxyVision(req, res);
  if (req.method === 'POST' && u === '/api/vision-gemini') return proxyVisionGemini(req, res);
  if (req.method === 'POST' && u === '/api/vision-local') return proxyVisionLocal(req, res);
  if (req.method === 'GET' && u === '/api/quicklist') return handleListGet(req, res, QUICKLIST_FILE);
  if (req.method === 'POST' && u === '/api/quicklist') return handleListAdd(req, res, QUICKLIST_FILE);
  if (req.method === 'POST' && u === '/api/quicklist/delete') return handleListDelete(req, res, QUICKLIST_FILE);
  if (req.method === 'GET' && u === '/api/listings') return handleListGet(req, res, LISTINGS_FILE);
  if (req.method === 'POST' && u === '/api/listings') return handleListAdd(req, res, LISTINGS_FILE);
  if (req.method === 'POST' && u === '/api/listings/delete') return handleListDelete(req, res, LISTINGS_FILE);
  if (req.method === 'GET' && u === '/api/prefs') return handlePrefsGet(req, res);
  if (req.method === 'POST' && u === '/api/prefs') return handlePrefsSave(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Snap → Sold server on http://localhost:${PORT}`);
  console.log('Auth: email+password (scrypt), sessions signed. API key supplied per-request by client.');
});
