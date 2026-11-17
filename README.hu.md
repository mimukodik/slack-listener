<h1 align="center">slack-listener</h1>

<p align="center">
  <a href="RULES.md">Szabályok</a> · <a href="PRINCIPLES.md">Elvek</a> · <a href="docs/hu/specifikacio.md">Specifikáció</a> · <a href="docs/hu/slack-app.md">Slack-app</a> · <a href="DECISIONS.md">Döntések</a> · <a href="README.md">English</a>
</p>

Claude Code channel-szerver, amely felébreszt egy munkamenetet, amikor valaki ír egy Slack-csatornába, így egyetlen munkamenetnek sem kell időzítve olvasnia. Egy engedélyezett küldő minden új üzenete abba a munkamenetbe érkezik, amelyik a figyelőt elindította, idézett adatként, a szerzőjével, a `ts`-sel és a `thread_ts`-sel.

- **A küldő számít.** Csak a megadott csatorna, és csak a felsorolt emberek és botok. A saját oldal ágenseinek posztjai sosem ébresztik a saját munkamenetet, így két oldal ágensei úgy oszthatnak meg egy csatornát, hogy nem ébresztik fel önmagukat.
- **Adat, nem utasítás.** Az üzenet minden sora `> `-vel idézve érkezik, így a küldő szövege nem adhatja ki magát a figyelő saját keretének. A figyelő sosem jelenti be a permission relayt.
- **Semmi nem vész el.** Kapcsolatszakadás, alvó laptop vagy összeomlás után a Slack előzményeiből felzárkózik. Ha a munkamenet egy üzenetet talán már látott, az `possible_duplicate` jelöléssel jön újra.
- **Csak olvas.** A szálbeli válasz az eszközön keresztül tervezett (RULES.md, 2. lépés), és ki van kapcsolva.
- **Szimulációval ellenőrzött.** A tiszta mag seedelt hibákkal futó hamis Slack ellen fut, és egy teljes bejárás minden legfeljebb 7 lépéses sorozatot lefed (87 796 sorozat, hiba nélkül).

## Futtatás

Node 26 vagy újabb, pnpm, és az [1Password CLI](https://developer.1password.com/docs/cli/) a tokenekhez.

1. Hozz létre egy Slack-appot és egy beállításfájlt: [docs/hu/slack-app.md](docs/hu/slack-app.md). A beállítás ne kerüljön repóba; a tokenek helyén `op://` hivatkozás áll, sosem érték.
2. Telepíts, és ellenőrizd a beállítást:

   ```sh
   pnpm install
   node src/main.ts --check --config <config.json>
   ```

3. Írj egy `mcp.json`-t bármely projekten kívül, hogy más munkamenet ne indítson második figyelőt:

   ```json
   {
     "mcpServers": {
       "slack-listener": {
         "command": "node",
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
pnpm lint            # formázás, oxlint, típusellenőrzés
pnpm test            # egységtesztek, megfelelőség, korlátos teljes bejárás
pnpm sim 2000 120    # a seedelt szimulátor: seedek x lépések
pnpm exhaustive 7    # minden lépéssorozat 7-ig
```

A viselkedés változása ugyanabban a pull requestben frissíti a [RULES.md](RULES.md)-t és mindkét specifikációt, az okát pedig a [DECISIONS.md](DECISIONS.md)-be írja. A dokumentáció angolul és magyarul is megvan; ha eltérnek, az angol a helyes. A [PRINCIPLES.md](PRINCIPLES.md) leírja, hogyan épül a kód: Tiger Style és determinisztikus szimulációs tesztelés, és hogy melyik elvet mi kényszeríti ki. A munka szabályait az [AGENTS.md](AGENTS.md) tartja.

## Licenc

[MIT](LICENSE-MIT) vagy [Apache-2.0](LICENSE-APACHE).
