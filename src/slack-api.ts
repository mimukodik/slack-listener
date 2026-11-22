import { Data, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientError } from "effect/http";

import { describeIssue } from "./decode.ts";
import { SlackMessageSchema, type SlackMessage } from "./slack.ts";

export class SlackApiError extends Data.TaggedError("SlackApiError")<{
  method: string;
  reason: string;
}> {}

export function redact(text: string): string {
  return text.replace(/x(?:ox[a-z]|app)-[A-Za-z0-9-]+/g, "[token]");
}

// Every answer says whether it is ok, and why not (R21).
const Answer = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});
const decodeAnswer = Schema.decodeUnknownResult(Answer);

// The fields each call reads from an ok answer; the rest are dropped.
const Messages = Schema.Struct({
  messages: Schema.optionalKey(Schema.Array(SlackMessageSchema)),
  response_metadata: Schema.optionalKey(
    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) }),
  ),
});
const Url = Schema.Struct({ url: Schema.optionalKey(Schema.String) });
const UserInfo = Schema.Struct({
  user: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      real_name: Schema.optionalKey(Schema.String),
      profile: Schema.optionalKey(
        Schema.Struct({ display_name: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
});
const Empty = Schema.Struct({});

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

  // R21: the answer is decoded where it arrives. One that does not decode is
  // a failed call, as a failed request is, and its reason names the field,
  // never a value.
  call<S extends Schema.ConstraintDecoder<unknown>>(
    method: string,
    params: Record<string, string>,
    answer: S,
    token: "bot" | "app" = "bot",
  ): Effect.Effect<S["Type"], SlackApiError> {
    const decodeBody = Schema.decodeUnknownResult(answer);
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
        const head = decodeAnswer(json);
        if (head._tag === "Failure")
          return Effect.fail(
            new SlackApiError({
              method,
              reason: `${method} answer ${describeIssue(head.failure)}`,
            }),
          );
        if (!head.success.ok)
          return Effect.fail(
            new SlackApiError({
              method,
              reason: head.success.error ?? "not ok",
            }),
          );
        const body = decodeBody(json);
        return body._tag === "Success"
          ? Effect.succeed(body.success)
          : Effect.fail(
              new SlackApiError({
                method,
                reason: `${method} answer ${describeIssue(body.failure)}`,
              }),
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
      return this.call(
        method,
        {
          ...params,
          limit: "200",
          ...(cursor === "" ? {} : { cursor }),
        },
        Messages,
      ).pipe(
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
    return this.call("apps.connections.open", {}, Url, "app").pipe(
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
    return this.call("auth.test", {}, Url).pipe(
      Effect.map((body) => body.url ?? ""),
    );
  }

  userName(user: string): Effect.Effect<string, SlackApiError> {
    return this.call("users.info", { user }, UserInfo).pipe(
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
    return this.call(
      "conversations.replies",
      {
        channel,
        ts: threadTs,
        limit: "1",
        inclusive: "true",
      },
      Messages,
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
    return this.call(
      "reactions.add",
      { channel, timestamp: ts, name },
      Empty,
    ).pipe(Effect.asVoid);
  }

  removeReaction(
    channel: string,
    ts: string,
    name: string,
  ): Effect.Effect<void, SlackApiError> {
    return this.call(
      "reactions.remove",
      { channel, timestamp: ts, name },
      Empty,
    ).pipe(Effect.asVoid);
  }

  canRead(channel: string): Effect.Effect<void, SlackApiError> {
    return this.call(
      "conversations.history",
      { channel, limit: "1" },
      Empty,
    ).pipe(Effect.asVoid);
  }
}
