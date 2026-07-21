# Snap → Sold

Vyfoť předmět (deskovku, nábytek, elektroniku, sport, kuchyň, auto-moto). Appka ho pozná z fotky,
předvyplní hráče/rozměry/specifikace podle kategorie a vygeneruje hotový inzerát pro Bazoš,
Zatrolené hry, Facebook, Vinted, Aukro nebo eBay. Uživatelé se mohou zaregistrovat a mít si
uloženou frontu položek a historii inzerátů.

## Soubory

- `snap-sold-cz.html` — celá appka (frontend), jeden soubor
- `server.js` — Node backend: účty (email+heslo), session cookies, proxy pro rozpoznávání z fotky
  (Claude / Gemini / lokální Ollama), uložení quicklistu/inzerátů/preferencí
- `manifest.json`, `sw.js`, `icon.svg` — PWA soubory (appka jde nainstalovat na plochu/mobil)
- `render.yaml` — konfigurace pro nasazení na Render.com
- `DEPLOY.md` — návod na nasazení krok za krokem

## Lokální spuštění

```bash
node server.js
```

Pak otevři `http://localhost:8080`.

Žádné npm balíčky nejsou potřeba — `server.js` používá jen vestavěné Node moduly.

## Rozpoznávání z fotky

Appka podporuje tři možnosti (nastavuje se v appce přes ⚙ Nastavení, per uživatel):

- **Claude** — potřebuje Anthropic API klíč (placené)
- **Gemini** — potřebuje Google Gemini API klíč (zdarma tier, viz aistudio.google.com/apikey)
- **Ollama** — lokální model, zdarma, offline, ale musí běžet na stejném stroji jako `server.js`
  (`ollama serve` + `ollama pull llava`)

Každý uživatel appky si vkládá svůj vlastní klíč — ten se ukládá jen v jeho prohlížeči
(`localStorage`), na server se nikdy neposílá k trvalému uložení, jen se přeposílá dál
při každém rozpoznávání.

## Nasazení na veřejnou URL

Viz `DEPLOY.md` — postup pro Render.com (zdarma tier).
