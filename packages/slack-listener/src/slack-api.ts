import { Data, Effect } from "effect";

import type { SlackMessage } from "./slack.ts";

export class SlackApiError extends Data.TaggedError("SlackApiError")<{
  method: string;
  reason: string;
}> {}

export function redact(text: string): string {
  return text.replace(/x(?:ox[a-z]|app)-[A-Za-z0-9-]+/g, "[token]");
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

export class SlackApi {
  private readonly botToken: string;
  private readonly appToken: string;

  constructor(botToken: string, appToken: string) {
    this.botToken = botToken;
    this.appToken = appToken;
  }

  call<T extends SlackResponse>(
    method: string,
    params: Record<string, string>,
    token: "bot" | "app" = "bot",
  ): Effect.Effect<T, SlackApiError> {
    const authorization = `Bearer ${token === "bot" ? this.botToken : this.appToken}`;
    return Effect.tryPromise({
      try: async () => {
        const response = await fetch(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body: new URLSearchParams(params).toString(),
        });
        if (response.status === 429)
          throw new Error(
            `rate limited, retry after ${response.headers.get("retry-after") ?? "?"} s`,
          );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as T;
      },
      catch: (error) =>
        new SlackApiError({
          method,
          reason: redact(String((error as Error).message ?? error)),
        }),
    }).pipe(
      Effect.flatMap((body) =>
        body.ok
          ? Effect.succeed(body)
          : Effect.fail(
              new SlackApiError({ method, reason: body.error ?? "not ok" }),
            ),
      ),
    );
  }

  private paged(
    method: string,
    params: Record<string, string>,
  ): Effect.Effect<SlackMessage[], SlackApiError> {
    const page = (
      cursor: string,
      collected: SlackMessage[],
      count: number,
    ): Effect.Effect<SlackMessage[], SlackApiError> => {
      if (count >= 100) {
        return Effect.fail(
          new SlackApiError({ method, reason: "more than 100 pages" }),
        );
      }
      return this.call<SlackResponse & { messages?: SlackMessage[] }>(method, {
        ...params,
        limit: "200",
        ...(cursor === "" ? {} : { cursor }),
      }).pipe(
        Effect.flatMap((body) => {
          const all = [...collected, ...(body.messages ?? [])];
          const next = body.response_metadata?.next_cursor ?? "";
          return next === "" ? Effect.succeed(all) : page(next, all, count + 1);
        }),
      );
    };
    return page("", [], 0);
  }

  history(
    channel: string,
    oldest: string,
  ): Effect.Effect<SlackMessage[], SlackApiError> {
    return this.paged("conversations.history", {
      channel,
      oldest,
      inclusive: "true",
    });
  }

  replies(
    channel: string,
    ts: string,
    oldest: string,
  ): Effect.Effect<SlackMessage[], SlackApiError> {
    return this.paged("conversations.replies", {
      channel,
      ts,
      oldest,
      inclusive: "true",
    });
  }

  openConnection(): Effect.Effect<string, SlackApiError> {
    return this.call<SlackResponse & { url?: string }>(
      "apps.connections.open",
      {},
      "app",
    ).pipe(
      Effect.flatMap((body) =>
        body.url
          ? Effect.succeed(body.url)
          : Effect.fail(
              new SlackApiError({
                method: "apps.connections.open",
                reason: "no url",
              }),
            ),
      ),
    );
  }

  teamUrl(): Effect.Effect<string, SlackApiError> {
    return this.call<SlackResponse & { url?: string; user_id?: string }>(
      "auth.test",
      {},
    ).pipe(Effect.map((body) => body.url ?? ""));
  }

  userName(user: string): Effect.Effect<string, SlackApiError> {
    return this.call<
      SlackResponse & {
        user?: {
          name?: string;
          real_name?: string;
          profile?: { display_name?: string };
        };
      }
    >("users.info", { user }).pipe(
      Effect.map((body) => {
        const profileName = body.user?.profile?.display_name;
        if (profileName) return profileName;
        return body.user?.real_name ?? body.user?.name ?? user;
      }),
    );
  }

  parentMessage(
    channel: string,
    threadTs: string,
  ): Effect.Effect<SlackMessage | null, SlackApiError> {
    return this.call<SlackResponse & { messages?: SlackMessage[] }>(
      "conversations.replies",
      {
        channel,
        ts: threadTs,
        limit: "1",
        inclusive: "true",
      },
    ).pipe(
      Effect.map((body) => {
        const first = body.messages?.[0];
        return first !== undefined && first.ts === threadTs ? first : null;
      }),
    );
  }

  channelInfo(
    channel: string,
  ): Effect.Effect<{ name: string; isMember: boolean }, SlackApiError> {
    return this.call<
      SlackResponse & { channel?: { name?: string; is_member?: boolean } }
    >("conversations.info", {
      channel,
    }).pipe(
      Effect.map((body) => ({
        name: body.channel?.name ?? channel,
        isMember: body.channel?.is_member === true,
      })),
    );
  }
}
