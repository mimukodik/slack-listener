English: [slack-app.md](../en/slack-app.md)

# A Slack-app létrehozása

Minden embernek saját app kell. Greg és eggp is így csinálja. eggp a `greg` helyére a saját nevét írja: az app nevében, a bot nevében és az 1Password-tételben.

Tokent soha ne másolj be sehova: se chatbe, se fájlba, se a beállításba. Az eszköz az 1Password-ből olvassa őket, `op read`-del.

## 1. App manifestből

api.slack.com/apps → Create New App → From a manifest → válaszd ki a workspace-t → másold be ezt a manifestet → Create.

Ez az a manifest, amellyel Greg az appját létrehozta. eggp a két névmezőben a saját nevét írja Greg helyére.

```yaml
display_information:
  name: slack-listener (Greg)
features:
  bot_user:
    display_name: slack-listener-greg
    always_online: false
oauth_config:
  scopes:
    bot:
      - groups:history
      - users:read
      - chat:write
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

A #berek-agent-lock csatornában:

```text
/invite @slack-listener-greg
```

eggp a saját botja nevét írja. A bot privát csatornán csak tagként kap eseményt és előzményt.

## 5. A tokenek 1Password-be

A `berek` vaultban hozz létre egy tételt „slack-listener greg” néven (eggp: „slack-listener <saját név>”). Két mezője legyen:

- `bot_token`: a 3. lépés `xoxb-…` tokenje;
- `app_token`: a 2. lépés `xapp-…` tokenje.

## Miért kell az egyes engedély

| Engedély            | Miért van benne                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `groups:history`    | A privát csatorna üzeneteit és szálait olvassa, élőben és újracsatlakozás után is.                                          |
| `users:read`        | A user id-kból megjelenítési nevet csinál.                                                                                  |
| `chat:write`        | Már most benne van, így az appot csak egyszer kell létrehozni. A válaszküldés a beállításban ki van kapcsolva a 2. lépésig. |
| `message.groups`    | Ez az esemény hozza az új üzeneteket Socket Mode-on.                                                                        |
| `connections:write` | Az app-szintű token ezzel nyitja a Socket Mode kapcsolatot.                                                                 |

## Miért kell mindenkinek saját app

A Slack egy app eseményeit szétosztja az app összes nyitott kapcsolata között. Ha két ember egy appot használna, mindkettőjük példánya üzeneteket veszítene.

## Utána

Írd meg a példány beállítását, például a `~/.config/slack-listener/config.json` fájlba. A user id-k helyére a valódiak kerülnek: `ownPeople` a saját oldal, `otherPeople` a másik oldal embere. A tokenek helyén csak `op://` hivatkozás állhat.

```json
{
  "channel": "C0000000000",
  "channelName": "berek-agent-lock",
  "ownPeople": ["U0000000001"],
  "otherPeople": ["U0000000002"],
  "otherBots": [],
  "tokens": {
    "bot": "op://berek/slack-listener greg/bot_token",
    "app": "op://berek/slack-listener greg/app_token"
  }
}
```

Ellenőrizd a repó gyökeréből:

```sh
node packages/slack-listener/src/main.ts --check --config <path>
```

A `--check` három dolgot néz meg: a bot-tokent, hogy a bot olvassa-e a csatornát, és a Socket Mode tokent.

Végül indítsd el a munkamenetet úgy, ahogy a [`README.md`](../../README.md) leírja.
