# Nasazení Snap → Sold na Render.com (zdarma)

## Předpoklad
Projekt musí být v Git repozitáři na GitHubu (zmiňoval jsi, že git už máš rozjetý).
Pokud ještě není na GitHubu:

```bash
cd cesta/ke/projektu
git init                      # pokud ještě není
git add .
git commit -m "Snap → Sold"
```

Pak na github.com vytvoř nové repo (klidně **Private**) a:

```bash
git remote add origin https://github.com/TVOJE-JMENO/snap-sold.git
git branch -M main
git push -u origin main
```

## Nasazení

1. Jdi na **render.com** → zaregistruj se (stačí přes GitHub účet, propojí se to rovnou).
2. **New +** → **Web Service**.
3. Vyber svůj repozitář `snap-sold`.
4. Render by měl automaticky najít `render.yaml` a předvyplnit nastavení. Pokud ne, ručně:
   - **Runtime:** Node
   - **Build Command:** (nech prázdné, nebo `echo ok`)
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. Klikni **Create Web Service**.
6. Po pár minutách dostaneš URL typu `https://snap-sold.onrender.com` — appka na ní běží.

## Co zkontrolovat po nasazení
- Otevři appku, zkus se zaregistrovat (email+heslo) — mělo by to fungovat.
- ⚙ Nastavení → Model pro rozpoznání → **Gemini** → vlož si SVŮJ Gemini klíč. Každý uživatel appky vkládá klíč zvlášť (ukládá se jen v jeho prohlížeči) — ty jako provozovatel neplatíš za cizí rozpoznávání fotek.
- Free tier appku po ~15 min neaktivity "uspí" — první požadavek po pauze potrvá 30–50 s, než se appka znovu nastartuje. Normální chování zdarma tieru, ne chyba.

## Důležité omezení zdarma tieru
`users.json`, `listings.json`, `quicklist.json` atd. se ukládají na disk kontejneru. Zdarma tier tenhle disk **nezaručuje napříč restarty/redeploy** — při update kódu nebo výpadku se účty/data mohou ztratit. Pro pár testovacích uživatelů je to v pořádku. Pokud appka chytne reálné uživatele a budeš chtít data trvale zachovat, ozvi se — přejdeme buď na placený trvalý disk (~1 $/měsíc), nebo na pořádnou databázi (SQLite soubor na perzistentním disku, nebo hostovaná Postgres — Render to nabízí taky zdarma v menší podobě).
