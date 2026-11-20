import { Data, Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientError } from "effect/http";

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

// The Slack Web API over Effect's HttpClient: production provides a client on
// the real fetch, the simulator one on its fake (world-through-services).
export class SlackApi {
  private readonly botToken: string;
  private readonly appToken: string;
  private readonly http: HttpClient.HttpClient;

  constructor(botToken: string, appToken: string, http: HttpClient.HttpClient) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.http = http;
  }

  static make(
    botToken: string,
    appToken: string,
  ): Effect.Effect<SlackApi, never, HttpClient.HttpClient> {
    return Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return new SlackApi(botToken, appToken, http);
    });
  }

  call<T extends SlackResponse>(
    method: string,
    params: Record<string, string>,
    token: "bot" | "app" = "bot",
  ): Effect.Effect<T, SlackApiError> {
    const request = HttpClientRequest.post(
      `https://slack.com/api/${method}`,
    ).pipe(
      HttpClientRequest.setHeader(
        "authorization",
        `Bearer ${token === "bot" ? this.botToken : this.appToken}`,
      ),
      HttpClientRequest.bodyUrlParams(params),
    );
    return this.http.execute(request).pipe(
      Effect.flatMap(
        (
          response,
        ): Effect.Effect<
          unknown,
          SlackApiError | HttpClientError.HttpClientError
        > => {
          if (response.status === 429)
            return Effect.fail(
              new SlackApiError({
                method,
                reason: `rate limited, retry after ${response.headers["retry-after"] ?? "?"} s`,
              }),
            );
          if (response.status < 200 || response.status > 299)
            return Effect.fail(
              new SlackApiError({ method, reason: `HTTP ${response.status}` }),
            );
          return response.json;
        },
      ),
      Effect.mapError((error) =>
        error._tag === "SlackApiError"
          ? error
          : new SlackApiError({ method, reason: redact(error.message) }),
      ),
      Effect.flatMap((json) => {
        const body = json as T;
        return body.ok
          ? Effect.succeed(body)
          : Effect.fail(
              new SlackApiError({ method, reason: body.error ?? "not ok" }),
            );
      }),
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
        body.url !== undefined && body.url !== ""
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
        if (profileName !== undefined && profileName !== "") return profileName;
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

  addReaction(
    channel: string,
    ts: string,
    name: string,
  ): Effect.Effect<void, SlackApiError> {
    return this.call<SlackResponse>("reactions.add", {
      channel,
      timestamp: ts,
      name,
    }).pipe(Effect.asVoid);
  }

  removeReaction(
    channel: string,
    ts: string,
    name: string,
  ): Effect.Effect<void, SlackApiError> {
    return this.call<SlackResponse>("reactions.remove", {
      channel,
      timestamp: ts,
      name,
    }).pipe(Effect.asVoid);
  }

  canRead(channel: string): Effect.Effect<void, SlackApiError> {
    return this.call<SlackResponse>("conversations.history", {
      channel,
      limit: "1",
    }).pipe(Effect.asVoid);
  }
}
