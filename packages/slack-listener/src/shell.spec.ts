import { PassThrough } from "node:stream";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ConfigError, parseConfig } from "./config.ts";
import { channelInstructions } from "./format.ts";
import { ChannelServer } from "./mcp.ts";
import { redact } from "./slack-api.ts";

function server() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Array<Record<string, unknown>> = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n"))
      if (line.trim() !== "") lines.push(JSON.parse(line));
  });
  const channel = new ChannelServer({
    name: "slack",
    version: "0.0.0",
    instructions: channelInstructions,
    input,
    output,
    onClosed: () => undefined,
    log: () => undefined,
  });
  const send = (message: object) => input.write(`${JSON.stringify(message)}\n`);
  return { channel, lines, send };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("channel server", () => {
  it("R3: declares the channel capability and never the permission relay", async () => {
    const { lines, send } = server();
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    await tick();
    const result = lines[0]?.result as {
      protocolVersion: string;
      capabilities: { experimental: Record<string, unknown> };
    };
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.experimental).toEqual({ "claude/channel": {} });
    expect(JSON.stringify(lines[0])).not.toContain("claude/channel/permission");
  });

  it("refuses to deliver before the session initialized, then writes one notification", async () => {
    const { channel, lines, send } = server();
    const early = await Effect.runPromise(
      Effect.result(channel.notify("hi", { ts: "1.2" })),
    );
    expect(early._tag).toBe("Failure");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await tick();
    await Effect.runPromise(channel.notify("hi", { ts: "1.2" }));
    await tick();
    expect(lines.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: { content: "hi", meta: { ts: "1.2" } },
    });
  });
});

describe("configuration", () => {
  const base = {
    channel: "C0WATCH001",
    ownPeople: ["U0OWN0001"],
    otherPeople: ["U0OTHER01"],
    tokens: {
      bot: "op://Private/slack-listener/bot_token",
      app: "op://Private/slack-listener/app_token",
    },
  };

  it("reads sides and token references", () => {
    const config = parseConfig(JSON.stringify(base), "test.json");
    expect(config.core.ownPeople).toEqual(["U0OWN0001"]);
    expect(config.core.otherPeople).toEqual(["U0OTHER01"]);
    expect(config.stateFile).toMatch(/C0WATCH001\.state\.json$/);
  });

  it("R6: refuses a literal token where a 1Password reference belongs", () => {
    const literal = {
      ...base,
      tokens: { bot: `xoxb-${"1".repeat(12)}`, app: base.tokens.app },
    };
    expect(() => parseConfig(JSON.stringify(literal), "test.json")).toThrow(
      ConfigError,
    );
  });
});

describe("R6: tokens stay secret", () => {
  it("redacts bot, user and app tokens from any log line", () => {
    const line = `failed with xoxb-${"1".repeat(10)}-abc and xapp-1-${"A".repeat(8)} and xoxp-${"2".repeat(6)}`;
    expect(redact(line)).toBe("failed with [token] and [token] and [token]");
  });
});

describe("configuration sides", () => {
  it("R10: refuses an id configured on both sides", () => {
    const both = {
      channel: "C0WATCH001",
      ownPeople: ["U0SHARED1"],
      otherPeople: ["U0SHARED1"],
      tokens: {
        bot: "op://vault/item/bot_token",
        app: "op://vault/item/app_token",
      },
    };
    expect(() => parseConfig(JSON.stringify(both), "test.json")).toThrow(
      /both sides/,
    );
  });
});
