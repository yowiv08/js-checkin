export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface AttemptDecision {
  failureKind?: "None" | "Upstream" | "InvalidCredential" | "Transport" | "Plugin";
  retry?: "None" | "NextAttempt";
  accountAction?: "None" | "Cooldown" | "Disable";
  accountCooldownUntil?: string;
  accountReason?: string;
  proxyAction?: "None" | "Cooldown";
  reasonCode?: string;
}

export type AttemptResult = {
  decision: AttemptDecision;
  statusCode?: number;
  reason?: string;
} | {
  outcome: "Healthy" | "Retry" | "CooldownNode" | "CooldownAccount" | "DisableAccount" | "NoPenalty";
  statusCode?: number;
  reason?: string;
};

export interface ModelDescriptor {
  id: string;
  displayName: string;
  contextWindow?: number;
  supportsStreaming?: boolean;
  inputLimit?: number;
  outputLimit?: number;
  supportsReasoning?: boolean;
  reasoningLevels?: string[] | null;
  reasoningTokenLimit?: number | null;
  creditMultiplier?: string | null;
}

export interface HttpRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  url: string;
  route?: "pool" | "direct" | "attempt";
  client?: string;
  headers?: Record<string, string>;
  body?: Json;
  bodyText?: string;
  bodyBase64?: string;
  form?: Record<string, string>;
  contentType?: string;
  originalJson?: {
    source: string;
    remove?: string[];
    set?: Record<string, Json>;
  };
  responseType?: "json" | "text" | "base64";
  timeoutMs?: number;
  readIdleTimeoutMs?: number;
  subscriptionIds?: string[];
  allowDirectFallback?: boolean;
  followRedirects?: boolean;
  retry?: {
    maxRetries: number;
    delayMs?: number;
    allowUnsafeMethods?: boolean;
  };
}

export interface HttpResult {
  statusCode: number;
  headers: Record<string, string[]>;
  body: Json;
  bodyText: string;
}

export interface HttpBinaryResult {
  statusCode: number;
  headers: Record<string, string[]>;
  bodyBase64: string;
}

export interface HttpClientHandle {
  handle: string;
  request(spec: HttpRequest & {
    responseType: "base64";
  }): Promise<HttpBinaryResult>;
  request(spec: HttpRequest & {
    responseType?: "json" | "text";
  }): Promise<HttpResult>;
  request(spec: HttpRequest): Promise<HttpResult | HttpBinaryResult>;
  open(spec: HttpRequest): Promise<HttpSource>;
  close(): Promise<void>;
}

export interface HttpApi {
  request(spec: HttpRequest & {
    responseType: "base64";
  }): Promise<HttpBinaryResult>;
  request(spec: HttpRequest & {
    responseType?: "json" | "text";
  }): Promise<HttpResult>;
  request(spec: HttpRequest): Promise<HttpResult | HttpBinaryResult>;
  open(spec: HttpRequest): Promise<HttpSource>;
  createClient(options?: {
    route?: "pool" | "direct";
    subscriptionIds?: string[];
    allowDirectFallback?: boolean;
  }): Promise<HttpClientHandle>;
  readText(handle: string): Promise<string>;
  readJson(handle: string): Promise<Json>;
  readBase64(handle: string): Promise<string>;
  drain(handle: string): Promise<{
    bytesRead: number;
  }>;
  snapshotError(handle: string): Promise<{
    text: string;
    truncated: boolean;
  }>;
  close(handle: string): Promise<void>;
  approvedOrigins(): Promise<string[]>;
  approveOrigin(origin: string): Promise<void>;
  revokeOrigin(origin: string): Promise<void>;
}

export interface HttpSource {
  handle: string;
  statusCode: number;
  headers: Record<string, string[]>;
  contentType: string;
}

export interface SseFrame {
  data: string;
  event?: string | null;
  id?: string | null;
  retry?: number | null;
}

export interface StreamChunk {
  delta?: string | null;
  reasoningDelta?: string | null;
  reasoningSignature?: string | null;
  role?: string | null;
  finishReason?: string | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  toolCalls?: Array<{
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }> | null;
  error?: string | null;
  errorType?: string | null;
}

export interface MapResult {
  state: Json;
  chunks: StreamChunk[];
  done?: boolean;
}
export type Credential =
  | {
      kind: "ApiKey";
      apiKey: string;
    }
  | {
      kind: "OAuth";
      accessToken: string;
      expiresAt?: string | null;
      refreshToken?: string | null;
      idToken?: string | null;
      accountId?: string | null;
      domain?: string | null;
      enterpriseId?: string | null;
      nickname?: string | null;
    }
  | {
      kind: "Custom";
      fields: Record<string, string | null>;
    }
  | {
      kind: "BearerToken";
      token: string;
      expiresAt?: string | null;
    }
  | {
      kind: "BasicAuth";
      username: string;
      password: string;
    }
  | {
      kind: "Cookie";
      cookie: string;
    };

export interface AccountStatus {
  state: "Active" | "Cooling" | "Draining" | "Invalid" | "Disabled" | "Removed";
  cooldownUntil?: string | null;
  disabledUntil?: string | null;
  reason?: string | null;
  lastStatusCode?: number | null;
  consecutiveFailures: number;
}

export interface AccountMetadata {
  id: string;
  platform: string;
  label?: string | null;
  expiresAt?: string | null;
  credentialKind: Credential["kind"];
  credentialVersion: string;
  credential?: Credential | null;
  credentialMetadata?: Record<string, Json> | null;
  status: AccountStatus;
}

export interface AccountInput {
  id?: string;
  platform?: string;
  label?: string | null;
  expiresAt?: string | null;
  credential?: Credential;
  status?: Partial<AccountStatus>;
}

export interface AccountsApi {
  ensureAnonymous(): Promise<AccountMetadata>;
  currentCredential(): Promise<Credential>;
  list(options?: {
    platform?: string;
    includeCredentials?: boolean;
  }): Promise<AccountMetadata[]>;
  get(id: string): Promise<AccountMetadata | null>;
  save(input: AccountInput): Promise<AccountMetadata>;
  delete(id: string): Promise<void>;
  readCredentials(id: string): Promise<{
    accountId: string;
    version: string;
    credential: Credential;
  }>;
  compareExchangeCredential(id: string, expectedVersion: string, credential: Credential): Promise<AccountMetadata | null>;
  refresh(id: string): Promise<AccountMetadata & {
    credential: Credential;
  }>;
  setCooldown(id: string, until: string, reason: string, statusCode?: number): Promise<void>;
  clearCooldown(id: string, expectedReason: string): Promise<boolean>;
  disable(id: string, reason: string, statusCode?: number): Promise<void>;
}

export interface StateApi {
  available(): Promise<boolean>;
  get(key: string): Promise<Json>;
  getString(key: string): Promise<string | null>;
  set(key: string, value: Json, options?: {
    ttlSeconds?: number;
  }): Promise<void>;
  setString(key: string, value: string, options?: {
    ttlSeconds?: number;
  }): Promise<void>;
  remove(key: string): Promise<void>;
  expiry(key: string): Promise<string | null>;
  putIfAbsent(key: string, value: Json, options?: {
    ttlSeconds?: number;
  }): Promise<boolean>;
  increment(key: string, delta?: string | number, options?: {
    ttlSeconds?: number;
  }): Promise<string>;
  compareExchange(key: string, expected: Json | undefined, value: Json | undefined, options?: {
    ttlSeconds?: number;
  }): Promise<boolean>;
}

export interface AccountPreference {
  accountId: string;
  eligible?: boolean;
  weight?: number;
  preferredExpiry?: string | null;
}
export interface AccountSelectionInput {
  candidates: AccountMetadata[];
}

export interface JobSnapshot {
  id: string;
  name: string;
  platform: string;
  key?: string | null;
  state: "Queued" | "Running" | "Completed" | "Failed" | "Cancelled";
  queuedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  progress?: Json;
  result?: Json;
  error?: string | null;
}

export interface JobsApi {
  start(name: string, input?: Json, options?: {
    key?: string;
    platform?: string;
  }): Promise<JobSnapshot>;
  get(id: string): Promise<JobSnapshot | null>;
  list(): Promise<JobSnapshot[]>;
  cancel(id: string): Promise<boolean>;
  wait(id: string): Promise<JobSnapshot | null>;
  progress(value: Json): Promise<void>;
}

export interface Completion {
  model: string;
  content?: string | null;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  toolCalls?: Array<{
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }>;
  reasoningContent?: string | null;
  reasoningSignature?: string | null;
}

export interface InvocationResult {
  response:
    | {
        kind: "completion";
        statusCode?: number;
        completion: Completion;
      }
    | {
        kind: "error";
        statusCode: number;
        message: string;
        errorType?: string;
      }
    | {
        kind: "mappedStream";
        statusCode?: number;
        source: string;
        mapper: string;
        state: Json;
      }
    | {
        kind: "raw";
        source: string;
      }
    | {
        kind: "raw";
        statusCode: number;
        bodyText?: string;
        bodyBase64?: string;
        contentType?: string;
        usage?: Completion["usage"];
      };
  attempt: AttemptResult;
}

export interface LogEntry {
  message: string;
  level?: "Debug" | "Information" | "Warning" | "Error";
  eventType?: string;
  accountId?: string;
  model?: string;
  statusCode?: number;
  durationMs?: number;
  details?: Json;
}

export interface TaskLogEntry {
  taskName: string;
  status: string;
  accountId?: string;
  message?: string;
  error?: string;
  details?: Json;
  durationMs?: number;
  startedAt?: string;
  finishedAt?: string;
}
export interface PluginContext {
  pluginKey: string;
  generationId: string;
  pluginVersion: string;
  platform: string;
  invocationId: string;
  traceId?: string;
  query?: Record<string, string>;
  body?: Json;
  task?: string;
  job?: {
    id: string;
  } | null;
  phase: "Terminal" | "Control" | "Task" | "Job" | "Selection" | "Callback" | "Stop";
  request?: {
    model: string;
    endpoint: string;
    stream: boolean;
    maxTokens?: number;
    temperature?: number;
    messages: Array<{
      role: string;
      content: string;
      contentParts?: Json[];
      [key: string]: unknown;
    }>;
    tools: Json[];
    extensions: Record<string, Json>;
    headers: Record<string, string>;
    originalBodyRef?: string | null;
  };
  account?: AccountMetadata | null;
  http: HttpApi;
  state: StateApi & {
    local: StateApi;
    shared: StateApi;
  };
  accounts: AccountsApi;
  models: {
    list(platform?: string): Promise<ModelDescriptor[]>;
    metadata(): Promise<{
      updatedAt: string;
      models: Array<{
        id: string;
        platform: string;
        platformName: string;
        displayName: string;
        contextWindow: number;
        inputLimit: number;
        outputLimit: number;
        supportsReasoning: boolean;
        reasoningLevels?: string[] | null;
        reasoningTokenLimit?: number | null;
      }>;
      protocols?: Record<string, string> | null;
      protocolsUpdatedAt?: string | null;
    }>;
    invalidate(platform?: string): Promise<void>;
    refresh(platform?: string): Promise<ModelDescriptor[]>;
  };
  tasks: {
    run(name: string): Promise<boolean>;
    writeLog(entry: TaskLogEntry): Promise<void>;
  };
  jobs: JobsApi;
  crypto: {
    randomUUID(): string;
    hash(algorithm: "SHA256" | "SHA384" | "SHA512", text: string): string;
    sha256(text: string): string;
    hmacSha256(key: string, text: string): string;
  };
  encoding: {
    toBase64(text: string): string;
    fromBase64(text: string): string;
    hexToBase64(text: string): string;
  };
  decimal: {
    add(left: string, right: string): string;
    subtract(left: string, right: string): string;
    multiply(left: string, right: string): string;
    divide(left: string, right: string): string;
    compare(left: string, right: string): number;
  };
  url: {
    parse(text: string): {
      href: string;
      origin: string;
      scheme: string;
      host: string;
      port: number;
      path: string;
      query: string;
      fragment: string;
    };
    resolve(base: string, relative: string): string;
  };
  reply: {
    completion(completion: Completion): InvocationResult;
    error(statusCode: number, message: string, decision?: AttemptDecision): InvocationResult;
    raw(source: HttpSource, decision?: AttemptDecision): InvocationResult;
    mappedStream(source: HttpSource, mapper: string, state: Json): InvocationResult;
  };
  log: {
    write(entry: LogEntry): Promise<void>;
  };
  delay(milliseconds: number): Promise<void>;
  json<T>(statusCode: number, body?: T): {
    statusCode: number;
    body?: T;
    contentType: "application/json";
  };
}

export interface HookNames {
  invoke: string;
  getModels?: string;
  validateCredential?: string;
  selectAccounts?: string;
  refreshCredential?: string;
  getMainPage?: string;
  start?: string;
  stop?: string;
}

export interface ExecutionPolicy {
  maxAttempts?: number;
  attemptTimeoutSeconds?: number;
  totalTimeoutSeconds?: number;
  transportFailure?: {
    retry?: boolean;
    cooldownProxy?: boolean;
    accountCooldownSeconds?: number;
  };
}

export interface PlatformManifest {
  name: string;
  displayName?: string;
  credentialKinds: Credential["kind"][];
  modelCacheTtlSeconds?: number;
  probeEndpoint?: string;
  hooks?: HookNames;
  policy?: ExecutionPolicy;
}

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  version: string;
  runtime: "jint";
  hostApi: "1" | "1-preview";
  entry: string;
  format: "esm-bundle";
  platform?: PlatformManifest;
  platforms?: PlatformManifest[];
  hooks?: HookNames;
  policy?: ExecutionPolicy;
  permissions?: {
    http?: {
      origins?: string[];
      routes?: Array<"direct" | "pool" | "attempt">;
      manageOrigins?: boolean;
    };
    accounts?: Array<"read" | "readCredentials" | "write" | "refresh" | "setCooldown" | "disable">;
    state?: Array<"read" | "write">;
    sharedState?: Array<"read" | "write">;
    models?: Array<"read" | "refresh" | "invalidate">;
    tasks?: Array<"run" | "writeLog">;
    jobs?: Array<"start" | "read" | "cancel">;
    crypto?: Array<"random" | "hash" | "hmac" | "encoding" | "decimal">;
    createAnonymousAccount?: boolean;
    readCurrentCredential?: boolean;
  };
  endpoints?: Array<{
    method: string;
    path: string;
    handler: string;
    platform?: string;
    auth?: "AdminSession" | "Internal" | "Anonymous" | "ApiKey" | "AdminSessionOrApiKey" | "Custom";
  }>;
  tasks?: Array<{
    name: string;
    handler: string;
    cron: string;
    platform?: string;
    timeoutSeconds?: number;
    description?: string;
  }>;
  jobs?: Array<{
    name: string;
    handler: string;
    platform?: string;
    timeoutSeconds?: number;
    description?: string;
  }>;
  page?: {
    title: string;
    entry: string;
  };
  streamMappers?: Record<string, {
    event: string;
    end: string;
    completion?: string;
  }>;
}
