# slack-listener

Egy Slack-csatornát figyel, és minden új üzenetet beküld abba a Claude Code
sessionbe, amelyik elindította. Így egyik sessionnek sem kell pollingoznia. Az
üzenet adatként érkezik, idézve, szerzővel, `ts`-sel és `thread_ts`-sel. Csak
olvas, még nem posztol.

English: [README.md](README.md).

- [`RULES.md`](RULES.md): a számozott szabályok, angolul. Ez a mérvadó.
- Specifikáció: [magyar](docs/hu/specifikacio.md),
  [English](docs/en/specification.md).
- Saját Slack app és konfiguráció: [magyar](docs/hu/slack-app.md),
  [English](docs/en/slack-app.md).

## Futtatás

Mindenki a saját példányát futtatja, a saját Slack appjával.

1. Hozd létre az appot és a konfigurációs fájlt:
   [`docs/hu/slack-app.md`](docs/hu/slack-app.md). A konfiguráció ne legyen
   repositoryban. A tokenek csak `op://` hivatkozások lehetnek.
2. Ellenőrizd a beállítást:

   ```sh
   node packages/slack-listener/src/main.ts --check --config <config.json>
   ```

3. Írj egy `mcp.json`-t, ami nincs egyik projektben sem. Így más session nem
   indít második figyelőt:

   ```json
   {
     "mcpServers": {
       "slack-listener": {
         "command": "node",
         "args": [
           "<checkout>/packages/slack-listener/src/main.ts",
           "--config",
           "<config.json>"
         ]
       }
     }
   }
   ```

4. Ezzel indítsd a fogadó sessiont:

   ```sh
   claude --mcp-config <mcp.json> \
     --dangerously-load-development-channels server:slack-listener
   ```

   A channels funkció kísérleti: csak interaktív sessionben működik, és
   induláskor megerősítést kér. Egy zárfájl miatt ugyanarra a csatornára nem
   indul második figyelő. A `--config` helyett a `--demo` egy mintaüzenetet küld
   Slack nélkül, hogy kipróbáld az utat.

## Mire támaszkodik

A csatorna azonosítójára és a beállított felhasználói és bot-azonosítókra. A
Slack `app_id` jelölésére az ügynöki posztokon. Ha a Slack ezt elhagyná, a saját
oldal ügynökei újra hallatszanának (RULES.md R10). A tokenekhez az 1Passwordre.
Arra a sessionre, amelyet ellát: az üzenetek ahhoz mennek, aki elindította, és
engedélykérést nem továbbít.

## A módszer, és mit adott

A mag egy tiszta `step(state, event, now)` függvény. A héj futtatja a hatásokat:
Slack, időzítők, a session, az állapotfájl. Az `src/sim` egy hamis Slack ellen
futtatja a magot, seedelt hibákkal. A fast-check választja a lépéseket, és
lerövidíti a hibás futást. Minden lépés után minden szabályt ellenőriz. Két
kontrollnak el kell buknia: egy buildnek, amely semmit sem kézbesít, és egynek,
amely mindent.

- Adott: négy valódi hibát talált a magban az első élő futás előtt. Mind
  megmaradt forgatókönyv-teszt az `src/core.spec.ts`-ben (szerkesztés elveszett
  egy összeomláskor a felzárkózás alatt; rossz sorrendű kiengedés; régebbi
  szerkesztés egy újabb után; késői újraküldés rossz sorrendben).
- Adott: egy kemény korlát kimondva, csendes rés helyett (szál-válasz
  szerkesztése kapcsolatszünet alatt; RULES.md, out of scope).
- Ára: a hamis Slack egy második modell, amit karban kell tartani. Eddig egy
  javítás kellett (a törölt szálnyitó üzenet sírkőként megmarad). Csak a Slack
  dokumentációjához van mérve, amíg rögzített valódi események nem váltják.
- Ára: az építési idő nagyjából harmada ment a szimulátorra és az ellenőrzőkre.
  Az egyik talált hiba az ellenőrző saját hibája volt.
- Nem használtuk: TLA+-t (a két példány lecsengését a fast-check modell lefedi)
  és mutációs tesztelést (kellene; a két kontroll az olcsó helyettese).

## Viselkedés változtatása

A viselkedés változása ugyanabban a pull requestben frissíti a `RULES.md`-t és
mindkét specifikációt. A megváltozott szabály új azonosítót kap, a törölt
azonosító nem kerül újra használatba. A dokumentáció angolul és magyarul is
megvan; ha eltérnek, az angol a mérvadó.
