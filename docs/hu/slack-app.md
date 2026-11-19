English: [slack-app.md](../en/slack-app.md)

# A Slack-app létrehozása

Mindenki a saját példányát futtatja, és saját app kell hozzá. A `<name>` helyére a saját neved írd: az app nevében, a bot nevében és az 1Password-tételben.

Tokent soha ne másolj be sehova: se chatbe, se fájlba, se a beállításba. Az eszköz az 1Password-ből olvassa őket, `op read`-del.

## 1. App manifestből

api.slack.com/apps → Create New App → From a manifest → válaszd ki a workspace-t → másold be ezt a manifestet → Create.

A két névmezőben írd a saját neved a `<name>` helyére.

```yaml
display_information:
  name: slack-listener (<name>)
features:
  bot_user:
    display_name: slack-listener-<name>
    always_online: false
oauth_config:
  scopes:
    bot:
      - groups:history
      - users:read
      - chat:write
      - reactions:write
settings:
  event_subscriptions:
    bot_events:
      - message.groups
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

## 2. App-szintű token

Basic Information → App-Level Tokens → Generate. A neve legyen `socket`, a scope `connections:write`. Az így kapott `xapp-…` token az app-token.

## 3. Telepítés

Install to Workspace. Utána az OAuth & Permissions oldalon ott a Bot User OAuth Token, `xoxb-…`. Ez a bot-token.

## 4. A bot meghívása a csatornába

A figyelt csatornában:

```text
/invite @slack-listener-<name>
```

A bot privát csatornán csak tagként kap eseményt és előzményt.

## 5. A tokenek 1Password-be

Egy általad választott 1Password-vaultban hozz létre egy tételt „slack-listener <name>” néven. Két mezője legyen:

- `bot_token`: a 3. lépés `xoxb-…` tokenje;
- `app_token`: a 2. lépés `xapp-…` tokenje.

## Miért kell az egyes engedély

| Engedély            | Miért van benne                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `groups:history`    | A privát csatorna üzeneteit és szálait olvassa, élőben és újracsatlakozás után is.                                                                |
| `users:read`        | A user id-kból megjelenítési nevet csinál.                                                                                                        |
| `chat:write`        | Már most benne van, így az appot csak egyszer kell létrehozni. A válaszküldés a beállításban ki van kapcsolva a 2. lépésig.                       |
| `reactions:write`   | A bot saját reakcióját teszi a kézbesített üzenetre, és pipára cseréli, amikor a ti oldalatok válaszolt, vagy a munkamenet késznek jelölte (R18). |
| `message.groups`    | Ez az esemény hozza az új üzeneteket Socket Mode-on.                                                                                              |
| `connections:write` | Az app-szintű token ezzel nyitja a Socket Mode kapcsolatot.                                                                                       |

Az R18 előtt létrehozott appból hiányzik a `reactions:write`: add hozzá az OAuth & Permissions → Bot Token Scopes alatt, és telepítsd újra az appot. Addig minden reakcióhívás sikertelen; az eszköz naplózza, és ugyanúgy kézbesít, mint eddig.

## Miért kell mindenkinek saját app

A Slack egy app eseményeit szétosztja az app összes nyitott kapcsolata között. Ha két ember egy appot használna, mindkettőjük példánya üzeneteket veszítene.

## Utána

Írd meg a példány beállítását, például a `~/.config/slack-listener/config.json` fájlba. A user id-k helyére a valódiak kerülnek: `ownPeople` a saját oldal, `otherPeople` a másik oldal emberei. A tokenek helyén csak `op://` hivatkozás állhat.

```json
{
  "channel": "C0000000000",
  "channelName": "coordination",
  "ownPeople": ["U0000000001"],
  "otherPeople": ["U0000000002"],
  "otherBots": [],
  "tokens": {
    "bot": "op://<vault>/slack-listener <name>/bot_token",
    "app": "op://<vault>/slack-listener <name>/app_token"
  }
}
```

A `reaction` és a `handledReaction` elhagyható, alapértékük `"eyes"` és `"heavy_check_mark"`: az első kerül a kézbesített üzenetre, a második váltja fel, amikor az üzenet el van intézve. A kettő nem lehet azonos (R18).

Ellenőrizd a repó gyökeréből:

```sh
node src/main.ts --check --config <path>
```

A `--check` három dolgot néz meg: a bot-tokent, hogy a bot olvassa-e a csatornát, és a Socket Mode tokent.

Végül indítsd el a munkamenetet úgy, ahogy a [`README.md`](../../README.md) leírja.
