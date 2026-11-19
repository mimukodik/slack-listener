import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultLimits, type CoreConfig } from "./core.ts";

export interface ListenerConfig {
  core: CoreConfig;
  channelName: string;
  serverName: string;
  botTokenRef: string;
  appTokenRef: string;
  stateFile: string;
  lockFile: string;
  recordFile: string | null;
  // R18: the reaction a delivered message gets, and the one it trades it for
  // once handled; Slack emoji names, and never the same one.
  reaction: string;
  handledReaction: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const defaultConfigPath = join(
  homedir(),
  ".config",
  "slack-listener",
  "config.json",
);

function stringField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new ConfigError(`config: "${key}" must be a non-empty string`);
  return value;
}

function idList(raw: Record<string, unknown>, key: string): string[] {
  const value = raw[key];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((v) => typeof v === "string" && /^[A-Z0-9]+$/.test(v))
  ) {
    throw new ConfigError(`config: "${key}" must be a list of Slack ids`);
  }
  return value;
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function parseConfig(text: string, sourcePath: string): ListenerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `config: ${sourcePath} is not valid JSON (${(error as Error).message})`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError("config: expected an object");
  const record = raw as Record<string, unknown>;
  const channel = stringField(record, "channel");
  if (!/^[CG][A-Z0-9]+$/.test(channel))
    throw new ConfigError(`config: "channel" must be a Slack channel id`);
  const ownPeople = idList(record, "ownPeople");
  const otherPeople = idList(record, "otherPeople");
  if (ownPeople.length === 0 && otherPeople.length === 0) {
    throw new ConfigError(
      "config: name at least one person in ownPeople or otherPeople",
    );
  }
  const sides = [...ownPeople, ...idList(record, "ownBots")].filter((id) =>
    [...otherPeople, ...idList(record, "otherBots")].includes(id),
  );
  if (sides.length > 0) {
    throw new ConfigError(
      `config: ${sides.join(", ")} is on both sides; an id belongs to one side`,
    );
  }
  const stateDir = expandHome(
    typeof record.stateDir === "string"
      ? record.stateDir
      : "~/.local/state/slack-listener",
  );
  const tokens = record.tokens as Record<string, unknown> | undefined;
  if (typeof tokens !== "object" || tokens === null)
    throw new ConfigError(
      'config: "tokens" must hold "bot" and "app" references',
    );
  const botTokenRef = stringField(tokens, "bot");
  const appTokenRef = stringField(tokens, "app");
  for (const ref of [botTokenRef, appTokenRef]) {
    if (!ref.startsWith("op://"))
      throw new ConfigError(
        "config: token references must be 1Password op:// references, never tokens",
      );
  }
  const reaction = emojiName(record, "reaction", "eyes");
  const handledReaction = emojiName(
    record,
    "handledReaction",
    "heavy_check_mark",
  );
  if (handledReaction === reaction)
    throw new ConfigError(
      'config: "handledReaction" must differ from "reaction", or the swap would take the mark off',
    );
  return {
    core: {
      channel,
      ownPeople,
      otherPeople,
      ownBots: idList(record, "ownBots"),
      otherBots: idList(record, "otherBots"),
      ...defaultLimits,
    },
    channelName:
      typeof record.channelName === "string" ? record.channelName : channel,
    serverName:
      typeof record.serverName === "string"
        ? record.serverName
        : "slack-listener",
    botTokenRef,
    appTokenRef,
    stateFile: join(stateDir, `${channel}.state.json`),
    lockFile: join(stateDir, `${channel}.lock`),
    recordFile:
      typeof record.recordFile === "string"
        ? expandHome(record.recordFile)
        : null,
    reaction,
    handledReaction,
  };
}

function emojiName(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = record[key] ?? fallback;
  if (typeof value !== "string" || !/^[a-z0-9_+'-]+$/.test(value))
    throw new ConfigError(
      `config: "${key}" must be a Slack emoji name, such as "${fallback}"`,
    );
  return value;
}

export function loadConfig(path: string): ListenerConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `config: cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
    );
  }
  return parseConfig(text, path);
}
