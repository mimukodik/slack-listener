<h1 align="center">slack-listener</h1>

<p align="center">
  <a href="RULES.md">Szabályok</a> · <a href="PRINCIPLES.md">Elvek</a> · <a href="docs/hu/specifikacio.md">Specifikáció</a> · <a href="docs/hu/slack-app.md">Slack-app</a> · <a href="DECISIONS.md">Döntések</a> · <a href="README.md">English</a>
</p>

**Először jársz itt?** [Mit próbáltunk ki a figyelő építése közben, mi vált be, és mi nyitott még (angolul).](experiments/README.md)

Claude Code channel-szerver, amely felébreszt egy munkamenetet, amikor valaki ír egy Slack-csatornába, így egyetlen munkamenetnek sem kell időzítve olvasnia. Egy engedélyezett küldő minden új üzenete abba a munkamenetbe érkezik, amelyik a figyelőt elindította, idézett adatként, a szerzőjével, a `ts`-sel és a `thread_ts`-sel.

- **A küldő számít.** Csak a megadott csatorna, és csak a felsorolt emberek és botok. A saját oldal ágenseinek posztjai sosem ébresztik a saját munkamenetet, így két oldal ágensei úgy oszthatnak meg egy csatornát, hogy nem ébresztik fel önmagukat.
- **Adat, nem utasítás.** Az üzenet minden sora `> `-vel idézve érkezik, így a küldő szövege nem adhatja ki magát a figyelő saját keretének. A figyelő sosem jelenti be a permission relayt.
- **Semmi nem vész el.** Kapcsolatszakadás, alvó laptop vagy összeomlás után a Slack előzményeiből felzárkózik. Ha a munkamenet egy üzenetet talán már látott, az `possible_duplicate` jelöléssel jön újra.
- **Csak olvas.** A szálbeli válasz az eszközön keresztül tervezett (RULES.md, 2. lépés), és ki van kapcsolva.
- **Szimulációval ellenőrzött.** Az éles Effect program seedelt hamis külvilágon fut; az ellenőrzők a munkamenet valódi kimenetét és a Slack nyugtáit vizsgálják. A korlátos teljes bejárás minden érvényes lépéssorozat-előtagot újrajátszik.

## Mi áll itt össze

A figyelő szándékosan kicsi. Azt dolgozzuk ki rajta, hogyan épüljön olyan szoftver, amelyet a kódoló ágensek gyorsan módosíthatnak úgy, hogy megmarad, amire az emberek számítanak. Ezek az ötletek kapcsolódnak össze:

- **Előbb a szabályok, aztán a kód.** A [RULES.md](RULES.md) a felhasználó nyelvén, számozott szabályokban mondja ki, mit kell tennie az eszköznek. Az első változata a kód előtt készült. Szabályt nem írunk át azért, hogy egy teszt átmenjen, és azonosítót nem használunk újra.
- **Tiszta mag, I/O a szélen.** Egyetlen függvény dönt: a `step(state, event, now)` az [src/core.ts](src/core.ts) fájlban. A döntéseket a körülötte lévő héj hajtja végre.
- **Effect a héjban.** A figyelő egyetlen [Effect](https://effect.website/) program, amely szolgáltatásokon át éri el az órát, a WebSocketet, a HTTP-t, a fájlrendszert és a munkamenetet.
- **A teljes program determinisztikus szimulációja.** A szimulátor ugyanezt a programot futtatja hamis külvilágon, seedelt ütemezővel és virtuális órával. Ugyanaz a seed ugyanazt a futást adja, a szabályokat pedig azon ellenőrizzük, amit a munkamenet és a Slack lát. A korlátos teljes bejárás minden érvényes, legfeljebb 7 lépésből álló sorozatot is lefuttat.
- **Modellek a kód mellett.** Két [TLA+ modell](spec/listener/README.md) fedi a figyelő kézbesítési, felzárkózási és reakciójelölési szabályait. Csak a szabályok alapján készültek, és a TLC modellellenőrző adott korlátokon belül mindkét modell minden állapotát bejárja. A task hubnál, a figyelő mellé épült második eszköznél a CI [a modell útjait](spec/tasks/README.md) a valódi kódon játssza vissza. (Mindkét leírás angolul.)
- **Egy ellenőrzést elrontott kódon bizonyítunk, mielőtt megbízunk benne.** A mérce egy ellenőrzésnél, lintszabálynál vagy tesztnél az, hogy elkapja a kód egy szándékosan elrontott változatát. A [PRINCIPLES.md](PRINCIPLES.md) megmondja, hol nem teljesül ez még.
- **A Tiger Style az irány.** A [PRINCIPLES.md](PRINCIPLES.md) a TigerBeetle [Tiger Style-ját](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md) követi: előbb a biztonság, aztán a teljesítmény, aztán a fejlesztői élmény. Minden elvnél megmondja, mi kényszeríti ki, és hogy a kód ma megfelel-e neki.
- **Egy akciódefiníció, minden felület.** A task hubban minden akció egyszer van definiálva, és ebből készül a REST az OpenAPI-dokumentumával, az MCP-eszközök, az RPC és a kliensoldali atomok ([src/action](src/action)).

[Mit próbáltunk ki, mit tartottunk meg és mit dobtunk el (angolul)](experiments/README.md): itt van mindegyikhez a bizonyíték.

## Futtatás

Bun 1.4.5 vagy újabb és az [1Password CLI](https://developer.1password.com/docs/cli/) a tokenekhez.

1. Hozz létre egy Slack-appot és egy beállításfájlt: [docs/hu/slack-app.md](docs/hu/slack-app.md). A beállítás ne kerüljön repóba; a tokenek helyén `op://` hivatkozás áll, sosem érték.
2. Telepíts, és ellenőrizd a beállítást:

   ```sh
   bun install
   bun src/main.ts --check --config <config.json>
   ```

3. Írj egy `mcp.json`-t bármely projekten kívül, hogy más munkamenet ne indítson második figyelőt:

   ```json
   {
     "mcpServers": {
       "slack-listener": {
         "command": "bun",
         "args": ["<checkout>/src/main.ts", "--config", "<config.json>"]
       }
     }
   }
   ```

4. Indítsd vele a fogadó munkamenetet:

   ```sh
   claude --mcp-config <mcp.json> \
     --dangerously-load-development-channels server:slack-listener
   ```

A channels kutatási előzetes: csak interaktív munkamenetben működik, induláskor megerősítést kér. Egy zárolófájl nem enged második figyelőt ugyanarra a csatornára. A `--config` helyett a `--demo` egy mintaeseményt küld Slack nélkül.

## Mire hagyatkozik

A csatorna azonosítójára és a beállított felhasználói és bot-azonosítókra. A Slack `app_id` jelölésére az ágensposztokon: ha a Slack elhagyná, a saját oldal ágensei újra hallatszanának (R10). A tokenekhez az 1Passwordre. Arra a munkamenetre, amelyet ellát: az események ahhoz mennek, aki elindította.

## Fejlesztés

```sh
bun run lint            # formázás, oxlint, típusellenőrzés
bun run test            # egységtesztek, megfelelőség, korlátos teljes bejárás
bun run sim 2000 120    # a seedelt szimulátor: seedek x lépések
bun run exhaustive 7    # minden lépéssorozat 7-ig
```

A viselkedés változása ugyanabban a pull requestben frissíti a [RULES.md](RULES.md)-t és mindkét specifikációt, az okát pedig a [DECISIONS.md](DECISIONS.md)-be írja. A dokumentáció angolul és magyarul is megvan; ha eltérnek, az angol a helyes. A [PRINCIPLES.md](PRINCIPLES.md) leírja, hogyan épül a kód: Tiger Style és determinisztikus szimulációs tesztelés, és hogy melyik elvet mi kényszeríti ki. A munka szabályait az [AGENTS.md](AGENTS.md) tartja.

## Licenc

[MIT](LICENSE-MIT) vagy [Apache-2.0](LICENSE-APACHE).
