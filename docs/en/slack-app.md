Magyarul: [slack-app.md](../hu/slack-app.md)

# Creating the Slack app

Each person runs their own instance and needs their own app. Put your own name where it says `<name>`: in the app name, the bot name and the 1Password item.

Never paste a token anywhere: not in a chat, a file or the configuration. The tool reads the tokens from 1Password with `op read`.

## 1. App from a manifest

api.slack.com/apps → Create New App → From a manifest → choose the workspace → paste this manifest → Create.

Replace `<name>` in both name fields.

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

## 2. App-level token

Basic Information → App-Level Tokens → Generate. Name it `socket`, with the scope `connections:write`. The `xapp-…` token it gives is the app token.

## 3. Install

Install to Workspace. The OAuth & Permissions page then shows the Bot User OAuth Token, `xoxb-…`. That is the bot token.

## 4. Invite the bot to the channel

In the channel to watch:

```text
/invite @slack-listener-<name>
```

In a private channel the bot receives events and history only as a member.

## 5. Tokens into 1Password

In a 1Password vault of your choice, create an item named "slack-listener <name>" with two fields:

- `bot_token`: the `xoxb-…` token from step 3;
- `app_token`: the `xapp-…` token from step 2.

## Why each permission is there

| Permission          | Why it is there                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `groups:history`    | Reads the private channel's messages and threads, live and when catching up after a reconnect.                   |
| `users:read`        | Turns user ids into display names.                                                                               |
| `chat:write`        | There from the start, so the app is created once. Replying stays switched off in the configuration until step 2. |
| `message.groups`    | The event that delivers new messages over Socket Mode.                                                           |
| `connections:write` | Lets the app-level token open the Socket Mode connection.                                                        |

## Why each person needs their own app

Slack spreads one app's events across all of that app's open connections. If two people shared an app, both instances would miss messages.

## Afterwards

Write the instance configuration, for example to `~/.config/slack-listener/config.json`. Put the real user ids in place of the placeholders: `ownPeople` is your side, `otherPeople` the people on the other side. The token fields take `op://` references only.

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

Check it from the repository root:

```sh
node src/main.ts --check --config <path>
```

`--check` checks three things: the bot token, that the bot can read the channel, and the Socket Mode token.

Then start the session as the [`README.md`](../../README.md) describes.
