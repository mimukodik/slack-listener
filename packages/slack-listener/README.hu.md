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
lerövidíti a hibás futást. A biztonsági szabályokat minden lépés után, a haladási
szabályokat minden futás végén ellenőrzi. Két
kontrollnak el kell buknia: egy buildnek, amely semmit sem kézbesít, és egynek,
amely mindent. A mintavétel mellett egy korlátos teljes bejárás
(`pnpm exhaustive 7`) minden legfeljebb 7 lépéses sorozatot lefuttat egy 8 elemű
ábécén (két szálnyitó, egy-egy válasz, szerkesztés, kapcsolatszakadás, összeomlás,
ismételt boríték): 87 796 sorozat, hiba nélkül; 8 lépésig 470 620. Egy megfelelőségi
teszt a hamis Slacket rögzített valódi eseményekkel veti össze.

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
  és gépileg ellenőrzött bizonyítást (ehhez az eszközhöz aránytalan). Mutációs
  ellenőrzés kézzel: minden új vagy szigorított ellenőrzésről megmutatjuk, hogy
  szándékosan elrontott buildnél elbukik; a számok a PR-ban vannak.

### Változások az első zöld futás után

Egy ellenőrzés gyengítéssel is átengedhető. Az első zöld futás utáni minden
változás a `RULES.md`-ben, a szimulátor ellenőrzőiben és a hamis Slackben, okkal:

| Mikor          | Mi                                                                                                                                                                                                                     | Irány                  | Ok                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| az 1. PR előtt | hamis Slack: a törölt szálnyitó sírkőként megmarad                                                                                                                                                                     | hamis Slack javítva    | Slack-dokumentáció                                                                                  |
| 11-17          | az R12 20-as hurokbiztosíték lesz; az R14 törölve                                                                                                                                                                      | szabály változott      | Greg: a gyakoriság korlátozása rossz eszköz                                                         |
| 11-17          | a 2. lépés posztolási kapuja: „amíg Greg nem látta a szabályokat” helyett „az 1. lépés élő bizonyítása és a lecsengési szimuláció után”; a `chat:write` kezdettől megvan, a posztolás konfigurációban ki van kapcsolva | szabály változott      | Greg döntése                                                                                        |
| 11-17, 1. PR   | az R9 helyett R16: a szálnyitót csak engedélyezett szerzőnél idézi                                                                                                                                                     | szigorúbb              | review: idegen szöveg jutott a munkamenetbe                                                         |
| 11-17, 1. PR   | out of scope: a Slack 3 mp-nél tágabb átrendezése                                                                                                                                                                      | szabály szűkült        | review: a 3 mp-es tartás ennél többet nem rendez                                                    |
| 11-17, 1. PR   | R2: a lehetséges duplikátum korlátos, összeomlásonként legfeljebb egy                                                                                                                                                  | ellenőrző szigorúbb    | korábban egy összeomlás után bármennyit elfogadott                                                  |
| 11-17, 1. PR   | egyszerre egy alvás, futáskorlát 12 → 48 óra                                                                                                                                                                           | hibamodell szűkebb     | az egymásra rakott alvások túlfutottak a korláton                                                   |
| 11-17, 1. PR   | futás csak élő kapcsolattal érhet véget                                                                                                                                                                                | ellenőrző szigorúbb    | halott kapcsolatnál véget ért futás kihagyta az R7-et                                               |
| 11-17, 1. PR   | R2 tartalom szerint, duplikátum összeomláshoz kötve, R3 soronként, szálazonosító a hamis Slackhez mérve, minden újracsatlakozási várakozás                                                                             | ellenőrzők szigorúbbak | review: gyenge ellenőrzők                                                                           |
| 11-17, 1. PR   | hamis Slack: alvó laptop, lassú és hibázó API, hamisított keret, azonos szövegű szerkesztés                                                                                                                            | hamis Slack keményebb  | review                                                                                              |
| 11-17, 1. PR   | hibázó API mellett a hívások fele bukik el, nem mind; kapcsolatszakadás a lépések 4 %-ában, nem 6 %-ában                                                                                                               | hibamodell enyhébb     | a vegyes válaszok elavult felzárkózási választ is előidéznek; az alvás vitt el 2 %-ot a szakadásból |
| 11-17, 2. PR   | az R16 helyett R17: a szálnyitót bármely beállított szerzőnél idézi                                                                                                                                                    | szabály tágabb         | az R16 hamis volt a saját koordinátorunk szálainál; bob2 jóváhagyta                                 |
| 11-17, 2. PR   | out of scope: kapcsolatszünet alatti azonos szövegű szerkesztés                                                                                                                                                        | szabály szűkült        | a felzárkózás nem tudja megkülönböztetni a valódi szerkesztéstől                                    |
| 11-17, 2. PR   | az R17 kimondja: azt nézi, ki posztolt, nem azt, honnan jött a szöveg                                                                                                                                                  | szabály pontosítva     | review                                                                                              |
| 11-17, 2. PR   | a szabályváltozást bob2 hagyja jóvá; Greghez csak szélesebb ébresztés, új megszólalás vagy gyengébb R3/R6 megy                                                                                                         | jóváhagyás lazább      | Greg, bob2-n keresztül                                                                              |
| 11-17, 2. PR   | R8 a szabály 60 mp-éhez mérve; keret saját sortörésekkel; fejlécsorok száma; a szálnyitó döntése közös a héjjal                                                                                                        | ellenőrzők szigorúbbak | review: el nem bukó ellenőrzések                                                                    |
| 11-17, 3. PR   | az R7 csak akkor menti fel a válasz szerkesztését, ha a Slack élőben sosem küldte el                                                                                                                                   | ellenőrző szigorúbb    | review: a felmentés az élő szerkesztésekre is vonatkozott                                           |

## Viselkedés változtatása

A viselkedés változása ugyanabban a pull requestben frissíti a `RULES.md`-t és
mindkét specifikációt. A megváltozott szabály új azonosítót kap, a törölt
azonosító nem kerül újra használatba. A dokumentáció angolul és magyarul is
megvan; ha eltérnek, az angol a mérvadó.
