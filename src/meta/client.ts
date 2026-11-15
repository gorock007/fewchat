import {
  classifyReadResponse,
  classifySendResponse,
  classifyTransportError,
  isId,
  isRecord,
  type Failure,
  type ReadOutcome,
  type ResponseInput,
  type SendOutcome,
} from "./errors";

export interface ShortToken {
  access_token: string;
  user_id: string;
  permissions: string;
}
export interface LongToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}
export interface Account {
  user_id: string;
  username?: string;
  account_type?: string;
}
export interface Media {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
}
export interface Comment {
  id: string;
  text?: string;
  from?: { id: string; username?: string };
  media?: { id: string; media_product_type?: string };
  timestamp?: string;
  parent_id?: string;
}
export interface Page<T> {
  data: T[];
  /** Pass after to the next call; never follow provider-supplied next URLs. */
  cursors?: { before?: string; after?: string };
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface PageOptions extends RequestOptions {
  after?: string;
  limit?: number;
}
export interface MetaClientOptions {
  fetch: (request: Request) => Promise<Response>;
  baseUrl: string;
  version: string;
}

function shortToken(body: unknown): ShortToken | null {
  const value =
    isRecord(body) && Array.isArray(body.data) ? body.data[0] : body;
  if (
    !isRecord(value) ||
    !isId(value.access_token) ||
    !isId(value.user_id) ||
    typeof value.permissions !== "string"
  )
    return null;
  return {
    access_token: value.access_token,
    user_id: value.user_id,
    permissions: value.permissions,
  };
}
function longToken(body: unknown): LongToken | null {
  if (
    !isRecord(body) ||
    !isId(body.access_token) ||
    !isId(body.token_type) ||
    typeof body.expires_in !== "number" ||
    !Number.isSafeInteger(body.expires_in) ||
    body.expires_in <= 0
  )
    return null;
  return {
    access_token: body.access_token,
    token_type: body.token_type,
    expires_in: body.expires_in,
  };
}
function optionalStrings(
  body: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every(
    (field) => body[field] === undefined || typeof body[field] === "string",
  );
}
function account(body: unknown): Account | null {
  if (
    !isRecord(body) ||
    !isId(body.user_id) ||
    !optionalStrings(body, ["username", "account_type"])
  )
    return null;
  return {
    user_id: body.user_id,
    ...(body.username === undefined
      ? {}
      : { username: body.username as string }),
    ...(body.account_type === undefined
      ? {}
      : { account_type: body.account_type as string }),
  };
}
const mediaFields = [
  "caption",
  "media_type",
  "media_product_type",
  "thumbnail_url",
  "permalink",
  "timestamp",
] as const;
const commentFields = ["text", "timestamp", "parent_id"] as const;
function validTimestamp(body: Record<string, unknown>): boolean {
  return (
    body.timestamp === undefined ||
    (typeof body.timestamp === "string" &&
      Number.isFinite(Date.parse(body.timestamp)))
  );
}
function media(body: unknown): Media | null {
  if (
    !isRecord(body) ||
    !isId(body.id) ||
    !optionalStrings(body, mediaFields) ||
    !validTimestamp(body)
  )
    return null;
  const result: Media = { id: body.id };
  for (const field of mediaFields)
    if (typeof body[field] === "string") result[field] = body[field];
  return result;
}
function comment(body: unknown): Comment | null {
  if (
    !isRecord(body) ||
    !isId(body.id) ||
    !optionalStrings(body, commentFields) ||
    !validTimestamp(body)
  )
    return null;
  const result: Comment = { id: body.id };
  for (const field of commentFields)
    if (typeof body[field] === "string") result[field] = body[field];
  if (body.from !== undefined) {
    if (
      !isRecord(body.from) ||
      !isId(body.from.id) ||
      !optionalStrings(body.from, ["username"])
    )
      return null;
    result.from = { id: body.from.id };
    if (typeof body.from.username === "string")
      result.from.username = body.from.username;
  }
  if (body.media !== undefined) {
    if (
      !isRecord(body.media) ||
      !isId(body.media.id) ||
      !optionalStrings(body.media, ["media_product_type"])
    )
      return null;
    result.media = { id: body.media.id };
    if (typeof body.media.media_product_type === "string")
      result.media.media_product_type = body.media.media_product_type;
  }
  return result;
}
function page<T>(validate: (body: unknown) => T | null) {
  return (body: unknown): Page<T> | null => {
    if (!isRecord(body) || !Array.isArray(body.data)) return null;
    const data: T[] = [];
    for (const item of body.data) {
      const value = validate(item);
      if (value === null) return null;
      data.push(value);
    }
    const result: Page<T> = { data };
    if (isRecord(body.paging) && isRecord(body.paging.cursors)) {
      const cursors = body.paging.cursors;
      result.cursors = {};
      if (typeof cursors.before === "string")
        result.cursors.before = cursors.before;
      // An end-of-list cursor is not proof there is another page.
      if (
        typeof body.paging.next === "string" &&
        typeof cursors.after === "string"
      )
        result.cursors.after = cursors.after;
    }
    return result;
  };
}

class ResponseBodyTooLarge extends Error {
  constructor(readonly httpStatus: number) {
    super("Meta response exceeds the 1 MiB body limit");
  }
}

async function responseText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    if (signal.aborted) cancel();
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) {
        cancel();
        throw new ResponseBodyTooLarge(response.status);
      }
      text += decoder.decode(value, { stream: true });
    }
    if (signal.aborted) throw new Error("Meta response body interrupted");
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Pure HTTP adapter. Callers own eligibility, token storage and delivery state. */
export function createMetaClient(config: MetaClientOptions) {
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new Error("Invalid Meta base URL");
  }
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.pathname !== "/" && base.pathname !== "")
  )
    throw new Error("Invalid Meta base URL");
  function graphUrl(path: string, versioned = true): URL {
    if (versioned && !/^v\d+\.\d+$/.test(config.version))
      throw new Error("Invalid Meta Graph version");
    return new URL(`${versioned ? `/${config.version}` : ""}/${path}`, base);
  }
  function segment(id: string): string {
    if (!isId(id) || id === "." || id === "..")
      throw new Error("Invalid Meta resource ID");
    return encodeURIComponent(id);
  }
  function bearer(token: string): Headers {
    required(token, "access token");
    return new Headers({ Authorization: `Bearer ${token}` });
  }
  function required(value: string, field: string): string {
    if (!isId(value)) throw new Error(`Missing Meta ${field}`);
    return value;
  }
  function jsonRequest(
    url: URL,
    token: string,
    body: unknown,
    signal: AbortSignal,
  ): Request {
    const headers = bearer(token);
    headers.set("Content-Type", "application/json");
    return new Request(url, {
      redirect: "manual",
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }

  async function execute<T>(
    build: (signal: AbortSignal) => Request,
    classify: (response: ResponseInput) => T,
    secrets: readonly string[],
    options: RequestOptions,
    retryRead = false,
  ): Promise<T | Failure> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispatched = false;
    let rejectAbort: ((error: Error) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    // An early rejection must be observed even if request construction fails.
    void aborted.catch(() => undefined);
    const abort = () => {
      controller.abort();
      rejectAbort?.(new Error("Meta request aborted or timed out"));
    };
    try {
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const timeout = options.timeoutMs ?? 30_000;
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw new Error("Invalid Meta request timeout");
      timer = setTimeout(abort, timeout);
      for (let attempt = 0; ; attempt++) {
        dispatched = false;
        if (controller.signal.aborted)
          throw new Error("Meta request aborted before dispatch");
        const request = build(controller.signal);
        // Check again in case a caller-supplied getter aborted during construction.
        if (controller.signal.aborted)
          throw new Error("Meta request aborted before dispatch");
        dispatched = true;
        try {
          const response = await Promise.race([
            (async () => {
              const result = await config.fetch(request);
              return {
                status: result.status,
                headers: result.headers,
                bodyText: await responseText(result, controller.signal),
              };
            })(),
            aborted,
          ]);
          if (
            retryRead &&
            attempt === 0 &&
            response.status >= 500 &&
            !controller.signal.aborted
          )
            continue;
          return classify(response);
        } catch (error) {
          if (
            retryRead &&
            attempt === 0 &&
            !controller.signal.aborted &&
            !(error instanceof ResponseBodyTooLarge)
          )
            continue;
          throw error;
        }
      }
    } catch (error) {
      const failure = classifyTransportError(error, { dispatched, secrets });
      return error instanceof ResponseBodyTooLarge
        ? { ...failure, httpStatus: error.httpStatus }
        : failure;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  function read<T>(
    path: () => string,
    token: string,
    fields: string,
    validate: (body: unknown) => T | null,
    options: PageOptions = {},
  ): Promise<ReadOutcome<T>> {
    return execute(
      (signal) => {
        const url = graphUrl(path());
        url.searchParams.set("fields", fields);
        if (options.after !== undefined)
          url.searchParams.set("after", options.after);
        if (options.limit !== undefined) {
          if (!Number.isSafeInteger(options.limit) || options.limit < 1)
            throw new Error("Invalid Meta page limit");
          url.searchParams.set("limit", String(options.limit));
        }
        return new Request(url, {
          headers: bearer(token),
          signal,
          redirect: "manual",
        });
      },
      (response) =>
        classifyReadResponse(response, validate, { secrets: [token] }),
      [token],
      options,
      true,
    );
  }

  return {
    exchangeCode(
      input: {
        clientId: string;
        clientSecret: string;
        redirectUri: string;
        code: string;
      },
      options: RequestOptions = {},
    ): Promise<ReadOutcome<ShortToken>> {
      const secrets: string[] = [];
      return execute(
        (signal) => {
          const code = required(
            required(input.code, "authorization code").replace(/#_$/, ""),
            "authorization code",
          );
          secrets.push(input.clientSecret, input.code, code);
          return new Request("https://api.instagram.com/oauth/access_token", {
            redirect: "manual",
            method: "POST",
            signal,
            body: new URLSearchParams({
              client_id: input.clientId,
              client_secret: input.clientSecret,
              grant_type: "authorization_code",
              redirect_uri: input.redirectUri,
              code,
            }),
          });
        },
        (response) => classifyReadResponse(response, shortToken, { secrets }),
        secrets,
        options,
      );
    },
    exchangeLongLived(
      input: { accessToken: string; clientSecret: string },
      options: RequestOptions = {},
    ): Promise<ReadOutcome<LongToken>> {
      const secrets = [input.accessToken, input.clientSecret];
      return execute(
        (signal) => {
          const url = graphUrl("access_token", false);
          url.search = new URLSearchParams({
            grant_type: "ig_exchange_token",
            client_secret: input.clientSecret,
            access_token: required(input.accessToken, "access token"),
          }).toString();
          return new Request(url, { signal, redirect: "manual" });
        },
        (response) => classifyReadResponse(response, longToken, { secrets }),
        secrets,
        options,
      );
    },
    refreshToken(
      accessToken: string,
      options: RequestOptions = {},
    ): Promise<ReadOutcome<LongToken>> {
      return execute(
        (signal) => {
          const url = graphUrl("refresh_access_token", false);
          url.search = new URLSearchParams({
            grant_type: "ig_refresh_token",
            access_token: required(accessToken, "access token"),
          }).toString();
          return new Request(url, { signal, redirect: "manual" });
        },
        (response) =>
          classifyReadResponse(response, longToken, { secrets: [accessToken] }),
        [accessToken],
        options,
      );
    },
    getAccount(accessToken: string, options: RequestOptions = {}) {
      return read(
        () => "me",
        accessToken,
        "user_id,username,account_type",
        account,
        options,
      );
    },
    getMedia(
      accountId: string,
      accessToken: string,
      options: PageOptions = {},
    ) {
      return read(
        () => `${segment(accountId)}/media`,
        accessToken,
        `id,${mediaFields.join(",")}`,
        page(media),
        options,
      );
    },
    getComment(
      commentId: string,
      accessToken: string,
      options: RequestOptions = {},
    ) {
      return read(
        () => segment(commentId),
        accessToken,
        "id,text,from,timestamp,parent_id,media",
        comment,
        options,
      );
    },
    getComments(
      mediaId: string,
      accessToken: string,
      options: PageOptions = {},
    ) {
      return read(
        () => `${segment(mediaId)}/comments`,
        accessToken,
        "id,text,from,timestamp,parent_id,media",
        page(comment),
        options,
      );
    },
    subscribeAccount(
      accountId: string,
      accessToken: string,
      options: RequestOptions = {},
    ): Promise<ReadOutcome<{ success: true }>> {
      return execute(
        (signal) => {
          const url = graphUrl(`${segment(accountId)}/subscribed_apps`);
          url.search = new URLSearchParams({
            subscribed_fields: "comments",
            access_token: required(accessToken, "access token"),
          }).toString();
          return new Request(url, {
            method: "POST",
            signal,
            redirect: "manual",
          });
        },
        (response) =>
          classifyReadResponse(
            response,
            (body) =>
              isRecord(body) && body.success === true
                ? { success: true as const }
                : null,
            { secrets: [accessToken] },
          ),
        [accessToken],
        options,
      );
    },
    sendPrivateReply(
      input: {
        accountId: string;
        commentId: string;
        text: string;
        accessToken: string;
      },
      options: RequestOptions = {},
    ): Promise<SendOutcome> {
      return execute(
        (signal) =>
          jsonRequest(
            graphUrl(`${segment(input.accountId)}/messages`),
            input.accessToken,
            {
              recipient: {
                comment_id: required(input.commentId, "comment ID"),
              },
              message: { text: required(input.text, "message text") },
            },
            signal,
          ),
        (response) =>
          classifySendResponse(response, {
            reply: "private",
            secrets: [input.accessToken],
          }),
        [input.accessToken],
        options,
      );
    },
    sendPublicReply(
      input: { commentId: string; text: string; accessToken: string },
      options: RequestOptions = {},
    ): Promise<SendOutcome> {
      return execute(
        (signal) =>
          jsonRequest(
            graphUrl(`${segment(input.commentId)}/replies`),
            input.accessToken,
            { message: required(input.text, "message text") },
            signal,
          ),
        (response) =>
          classifySendResponse(response, {
            reply: "public",
            secrets: [input.accessToken],
          }),
        [input.accessToken],
        options,
      );
    },
  };
}
