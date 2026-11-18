// DevTools as an ExchangeSource: priming via DevToolsShim, synchronous snapshots at export start,
// batched stack-trace reads with actions enabled, HarBuilder metadata with actions paused, and
// response bodies streamed from LongStringActor slices. Nothing loads Loader while uninitialized.

import { buildHarEntry } from "@one-click-har/har/build";
import {
  isoDateTimeFromEpochMs,
  toHarUrl,
  toIsoDateTime,
  type ChromeInitiator,
  type ChromeInitiatorCallFrame,
  type ChromeWebSocketMessage,
  type HarCache,
  type HarCookie,
  type HarEntry,
  type HarNameValue,
  type HarPostDataParam,
  type HarTimings,
  type HarUrl,
} from "@one-click-har/har/model";
import { inSelection, type ResolvedSelection } from "@one-click-har/export/selection";
import {
  classifyUrl,
  type BodyCandidates,
  type BodyReader,
  type DevtoolsBodyRef,
  type ExchangeSource,
  type Material,
  type SourceItem,
  type SourceListing,
  type SourceRef,
} from "@one-click-har/export/source";
import {
  exchangeId,
  parseChannelKey,
  toMinute,
  type EpochMs,
  type Minute,
  type RunId,
  type Site,
  type TabId,
  type TabKey,
} from "@one-click-har/recording/ids";
import type { ToolboxState } from "./contract.ts";
import { siteOfUri } from "./gecko-io.ts";

const SHIM_URL = "chrome://devtools-startup/content/DevToolsShim.sys.mjs";
const LOADER_URL = "resource://devtools/shared/loader/Loader.sys.mjs";
const HAR_BUILDER_ID = "resource://devtools/client/netmonitor/src/har/har-builder.js";
const DEVTOOLS_FRAMEWORK_ID = "resource://devtools/client/framework/devtools.js";
/** Maximum characters per LongStringActor.substring RDP packet so the parent main thread stays responsive. */
const LONG_STRING_SLICE_CHARS = 1_048_576;

const RESOURCE_TYPE_MAP: { readonly [causeType: string]: string } = {
  xhr: "xhr",
  fetch: "fetch",
  document: "document",
  subdocument: "document",
  script: "script",
  stylesheet: "stylesheet",
  img: "image",
  imageset: "image",
  font: "font",
  media: "media",
  websocket: "websocket",
  beacon: "ping",
  ping: "ping",
};

type DevtoolsBodyHandle =
  | { readonly kind: "string"; readonly text: string }
  | {
      readonly kind: "grip";
      readonly client: DevToolsClient;
      readonly grip: DevToolsLongStringGrip;
    };

interface HeldDevtoolsItem {
  readonly api: NetMonitorApi;
  readonly request: DevToolsRequestItem;
}

const shim = () => ChromeUtils.importESModule(SHIM_URL).DevToolsShim;

const devtoolsModules = () => {
  const loader = ChromeUtils.importESModule(LOADER_URL);
  return {
    gDevTools: loader.require(DEVTOOLS_FRAMEWORK_ID).gDevTools,
    HarBuilder: loader.require(HAR_BUILDER_ID).HarBuilder,
  };
};

/** Loading the DevTools client framework is expensive. Until DevTools starts, no toolbox can exist. */
export const toolboxOf = (tab: NativeTab): ToolboxState => {
  const dtShim = shim();
  if (!dtShim.isInitialized()) return { open: false, reason: "devtools-not-started" };
  const { gDevTools } = devtoolsModules();
  const toolbox = gDevTools.getToolboxForTab(tab);
  return toolbox === undefined
    ? { open: false, reason: "no-toolbox-for-tab" }
    : { open: true, host: toolbox.hostType };
};

const STACK_PREFETCH_CHUNK = 128;

const cachedApis = new WeakMap<DevToolsToolbox, NetMonitorApi>();

const syncApiOf = (toolbox: DevToolsToolbox): NetMonitorApi | null => {
  const panelApi = toolbox.getPanel?.("netmonitor")?.panelWin?.Netmonitor?.api;
  if (panelApi !== undefined) {
    cachedApis.set(toolbox, panelApi);
    return panelApi;
  }
  return cachedApis.get(toolbox) ?? null;
};

const apiOf = async (toolbox: DevToolsToolbox): Promise<NetMonitorApi> => {
  const live = toolbox.getPanel?.("netmonitor")?.panelWin?.Netmonitor?.api;
  if (live !== undefined) {
    cachedApis.set(toolbox, live);
    return live;
  }
  const api = await toolbox.getNetMonitorAPI();
  cachedApis.set(toolbox, api);
  return api;
};

/**
 * Registers through DevToolsShim without loading DevTools. When a toolbox opens on Inspector or Console, calls
 * `getNetMonitorAPI()` so network capture starts before the user ever visits the Network panel (row D3).
 */
export function primeToolboxes(): { dispose(): void } {
  const dtShim = shim();
  const prime = (toolbox: DevToolsToolbox): void => {
    void toolbox
      .getNetMonitorAPI()
      .then((api) => {
        cachedApis.set(toolbox, api);
      })
      .catch(() => undefined);
  };
  dtShim.on("toolbox-ready", prime);
  if (dtShim.isInitialized()) {
    for (const toolbox of dtShim.getToolboxes()) prime(toolbox);
  }
  return {
    dispose: () => {
      try {
        dtShim.off("toolbox-ready", prime);
      } catch {
        // DevTools may already have unregistered during shutdown.
      }
    },
  };
}

const siteOfUrl = (raw: string): Site | null => {
  try {
    return siteOfUri(Services.io.newURI(raw));
  } catch {
    return null;
  }
};

const isLongStringGrip = (value: unknown): value is DevToolsLongStringGrip =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly type?: unknown }).type === "longString" &&
  typeof (value as { readonly actor?: unknown }).actor === "string" &&
  typeof (value as { readonly initial?: unknown }).initial === "string" &&
  typeof (value as { readonly length?: unknown }).length === "number";

const isBlocked = (request: DevToolsRequestItem): boolean => Boolean(request.blockedReason);

const isInProgress = (request: DevToolsRequestItem): boolean =>
  request.totalTime === undefined && !isBlocked(request);

const mapPairs = (raw: unknown): readonly HarNameValue[] =>
  Array.isArray(raw)
    ? raw
        .filter(
          (pair): pair is { readonly name: string; readonly value: unknown } =>
            typeof pair === "object" &&
            pair !== null &&
            typeof (pair as { name?: unknown }).name === "string",
        )
        .map((pair) => ({
          name: pair.name,
          value: typeof pair.value === "string" ? pair.value : String(pair.value ?? ""),
        }))
    : [];

const mapCookies = (raw: unknown): readonly HarCookie[] =>
  Array.isArray(raw)
    ? raw
        .filter(
          (cookie): cookie is Record<string, unknown> =>
            typeof cookie === "object" &&
            cookie !== null &&
            typeof (cookie as { name?: unknown }).name === "string",
        )
        .map((cookie) => ({
          name: String(cookie["name"]),
          value:
            typeof cookie["value"] === "string" ? cookie["value"] : String(cookie["value"] ?? ""),
          ...(typeof cookie["path"] === "string" ? { path: cookie["path"] } : {}),
          ...(typeof cookie["domain"] === "string" ? { domain: cookie["domain"] } : {}),
          ...(typeof cookie["expires"] === "string" || cookie["expires"] === null
            ? { expires: cookie["expires"] }
            : {}),
          ...(typeof cookie["httpOnly"] === "boolean" ? { httpOnly: cookie["httpOnly"] } : {}),
          ...(typeof cookie["secure"] === "boolean" ? { secure: cookie["secure"] } : {}),
        }))
    : [];

const mapParams = (raw: unknown): readonly HarPostDataParam[] =>
  Array.isArray(raw)
    ? raw
        .filter(
          (param): param is Record<string, unknown> =>
            typeof param === "object" &&
            param !== null &&
            typeof (param as { name?: unknown }).name === "string",
        )
        .map((param) => ({
          name: String(param["name"]),
          ...(typeof param["value"] === "string" ? { value: param["value"] } : {}),
          ...(typeof param["fileName"] === "string" ? { fileName: param["fileName"] } : {}),
          ...(typeof param["contentType"] === "string"
            ? { contentType: param["contentType"] }
            : {}),
        }))
    : [];

const mapTimings = (raw: unknown): Partial<HarTimings> => {
  const t = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  const num = (key: string): number | undefined => {
    const v = t?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  return {
    ...(num("blocked") !== undefined ? { blocked: num("blocked") } : {}),
    ...(num("dns") !== undefined ? { dns: num("dns") } : {}),
    ...(num("connect") !== undefined ? { connect: num("connect") } : {}),
    send: num("send") ?? -1,
    wait: num("wait") ?? -1,
    receive: num("receive") ?? -1,
    ...(num("ssl") !== undefined ? { ssl: num("ssl") } : {}),
    ...(typeof t?.["comment"] === "string" ? { comment: t["comment"] } : {}),
    ...(num("_blocked_queueing") !== undefined
      ? { _blocked_queueing: num("_blocked_queueing") }
      : {}),
    ...(num("_blocked_proxy") !== undefined ? { _blocked_proxy: num("_blocked_proxy") } : {}),
    ...(num("_workerStart") !== undefined ? { _workerStart: num("_workerStart") } : {}),
    ...(num("_workerReady") !== undefined ? { _workerReady: num("_workerReady") } : {}),
    ...(num("_workerFetchStart") !== undefined
      ? { _workerFetchStart: num("_workerFetchStart") }
      : {}),
    ...(num("_workerRespondWithSettled") !== undefined
      ? { _workerRespondWithSettled: num("_workerRespondWithSettled") }
      : {}),
  };
};

const resourceTypeOf = (request: DevToolsRequestItem): string | undefined => {
  const causeType = request.cause?.type;
  if (typeof causeType === "string") {
    const mapped = RESOURCE_TYPE_MAP[causeType];
    if (mapped !== undefined) return mapped;
  }
  if (request.isNavigationRequest === true) return "document";
  if (request.isXHR === true) return "xhr";
  return typeof causeType === "string" && causeType.length > 0 ? causeType : undefined;
};

const fromCacheOf = (fromCache: boolean | string | undefined): string | undefined => {
  if (fromCache === "memory") return "memory";
  if (fromCache === true || typeof fromCache === "string") return "disk";
  return undefined;
};

const wsMessagesFor = async (
  api: NetMonitorApi,
  request: DevToolsRequestItem,
): Promise<readonly ChromeWebSocketMessage[] | undefined> => {
  if (request.resourceId === undefined || request.resourceId === null) return undefined;
  const map = api.store.getState().messages?.messages;
  const frames = map?.get(request.resourceId) ?? map?.get(String(request.resourceId));
  if (!Array.isArray(frames) || frames.length === 0) return undefined;
  const out: ChromeWebSocketMessage[] = [];
  for (const frame of frames) {
    let data: string;
    if (typeof frame.payload === "string") {
      data = frame.payload;
    } else if (isLongStringGrip(frame.payload)) {
      try {
        data = await api.connector.getLongString(frame.payload);
      } catch {
        data = frame.payload.initial;
      }
    } else {
      data = String(frame.payload ?? "");
    }
    out.push({
      type: frame.type === "send" ? "send" : "receive",
      time: typeof frame.timeStamp === "number" ? frame.timeStamp : 0,
      opcode: typeof frame.opCode === "number" ? frame.opCode : 1,
      data,
    });
  }
  return out.length > 0 ? out : undefined;
};

const initiatorFor = async (
  api: NetMonitorApi,
  request: DevToolsRequestItem,
): Promise<ChromeInitiator | undefined> => {
  const latest = api.store.getState().requests.requests.find((r) => r.id === request.id) ?? request;
  let frames: readonly DevToolsStackFrame[] | undefined =
    Array.isArray(latest.stacktrace) && latest.stacktrace.length > 0
      ? latest.stacktrace
      : undefined;
  if (frames === undefined && latest.cause?.stacktraceAvailable === true) {
    try {
      // Actions must stay enabled: with actions off, requestData deletes the lookup without storing the stack.
      api.connector.enableActions(true);
      const fetched = await api.connector.requestData(latest.id, "stackTrace");
      if (Array.isArray(fetched) && fetched.length > 0) {
        frames = fetched as readonly DevToolsStackFrame[];
      }
    } catch {
      // Actor may already be gone; continue with cause metadata alone.
    }
  }
  const cause = latest.cause ?? request.cause;
  if (cause === undefined && (frames === undefined || frames.length === 0)) return undefined;
  const callFrames: ChromeInitiatorCallFrame[] = (frames ?? []).map((frame) => ({
    functionName: typeof frame.functionName === "string" ? frame.functionName : "",
    scriptId: "",
    url: typeof frame.filename === "string" ? frame.filename : "",
    lineNumber: typeof frame.lineNumber === "number" ? frame.lineNumber : 0,
    columnNumber: typeof frame.columnNumber === "number" ? frame.columnNumber : 0,
    ...(frame.asyncCause !== undefined && frame.asyncCause !== null
      ? { asyncCause: frame.asyncCause }
      : {}),
  }));
  return {
    type: typeof cause?.type === "string" && cause.type.length > 0 ? cause.type : "other",
    ...(typeof cause?.loadingDocumentUri === "string" && cause.loadingDocumentUri.length > 0
      ? { url: cause.loadingDocumentUri }
      : {}),
    ...(callFrames.length > 0 ? { stack: { callFrames } } : {}),
  };
};

/**
 * Wraps the connector passed to HarBuilder so it never resolves responseContent via getLongStringFullText.
 * Response bodies are fetched separately via raw getResponseContent and streamed in slices.
 */
const metadataConnector = (connector: NetMonitorConnector): NetMonitorConnector => ({
  currentTarget: connector.currentTarget,
  enableActions: (enable) => connector.enableActions(enable),
  requestData: (actorId, method) =>
    method === "responseContent"
      ? Promise.resolve(undefined)
      : connector.requestData(actorId, method),
  getLongString: (grip) => connector.getLongString(grip),
  ...(connector.getTimingMarker !== undefined
    ? { getTimingMarker: (name: string) => connector.getTimingMarker!(name) }
    : {}),
  ...(connector.getHarData !== undefined ? { getHarData: () => connector.getHarData!() } : {}),
});

interface CapturedToolbox {
  readonly toolbox: DevToolsToolbox;
  readonly localTab: NativeTab;
  readonly tabKey: TabKey;
  readonly fallbackSite: Site | null;
  readonly api: NetMonitorApi | null;
  readonly requests: readonly DevToolsRequestItem[] | null;
}

export function createDevtoolsSource(options: {
  readonly run: RunId;
  readonly tabOf: (tabId: TabId) => NativeTab | null;
  readonly canAccessTab?: (tab: NativeTab) => boolean;
}): {
  readonly source: ExchangeSource;
  readonly bodies: BodyReader;
  readonly firstMinute: (tabId: TabId) => Promise<Minute | null>;
  readonly snapshot: (tabId: TabId | null) => void;
} {
  const { run, tabOf } = options;
  const canAccess = options.canAccessTab ?? (() => true);
  const bodyRefs = new WeakMap<DevtoolsBodyRef, DevtoolsBodyHandle>();
  const held: HeldDevtoolsItem[] = [];
  const prefetchedApis = new WeakSet<NetMonitorApi>();
  let capturedSnapshots: CapturedToolbox[] | null = null;

  const registerHandle = (handle: DevtoolsBodyHandle): DevtoolsBodyRef => {
    const ref = {} as DevtoolsBodyRef;
    bodyRefs.set(ref, handle);
    return ref;
  };

  const toolboxesForSelection = (tabId: TabId | null): readonly DevToolsToolbox[] => {
    const dtShim = shim();
    if (!dtShim.isInitialized()) return [];
    if (tabId !== null) {
      const tab = tabOf(tabId);
      if (tab === null) return [];
      const { gDevTools } = devtoolsModules();
      const toolbox = gDevTools.getToolboxForTab(tab);
      return toolbox === undefined ? [] : [toolbox];
    }
    return dtShim.getToolboxes().filter((toolbox) => {
      const localTab = toolbox.commands?.descriptorFront?.localTab;
      return localTab !== undefined && canAccess(localTab);
    });
  };

  const sortedRequests = (api: NetMonitorApi): readonly DevToolsRequestItem[] =>
    // Sort by startedMs regardless of the panel's UI sort (row D2: size sort broke HarExporter).
    [...api.store.getState().requests.requests].sort((a, b) => a.startedMs - b.startedMs);

  const snapshot = (tabId: TabId | null): void => {
    const toolboxes = toolboxesForSelection(tabId);
    const out: CapturedToolbox[] = [];
    for (const toolbox of toolboxes) {
      const localTab = toolbox.commands?.descriptorFront?.localTab;
      if (localTab === undefined) continue;
      const api = syncApiOf(toolbox);
      out.push({
        toolbox,
        localTab,
        tabKey: { run, browserId: localTab.linkedBrowser.browserId },
        fallbackSite: siteOfUri(localTab.linkedBrowser.currentURI),
        api,
        requests: api === null ? null : sortedRequests(api),
      });
    }
    capturedSnapshots = out;
  };

  const firstMinute = async (tabId: TabId): Promise<Minute | null> => {
    let requests: readonly DevToolsRequestItem[] | null = null;
    if (capturedSnapshots !== null) {
      const snap = capturedSnapshots[0];
      if (snap === undefined) return null;
      requests = snap.requests ?? sortedRequests(await apiOf(snap.toolbox));
    } else {
      const toolbox = toolboxesForSelection(tabId)[0];
      if (toolbox === undefined) return null;
      requests = sortedRequests(await apiOf(toolbox));
    }
    let earliest: number | null = null;
    for (const request of requests) {
      if (classifyUrl(request.url).kind !== "network") continue;
      if (earliest === null || request.startedMs < earliest) earliest = request.startedMs;
    }
    return earliest === null ? null : toMinute(Math.floor(earliest) as EpochMs);
  };

  const missingContent = (
    packet: DevToolsResponseContentPacket,
    latest: DevToolsRequestItem,
  ): boolean => {
    const declared = packet.content?.size ?? latest.contentSize ?? 0;
    return packet.content?.text === undefined || packet.content?.text === null || declared > 0;
  };

  const resolveResponseBody = async (
    api: NetMonitorApi,
    request: DevToolsRequestItem,
    includeBody: boolean,
    status: number,
  ): Promise<BodyCandidates> => {
    const latest =
      api.store.getState().requests.requests.find((r) => r.id === request.id) ?? request;
    const liveStatus = Number(latest.status) || status;

    if (latest.truncated === true || request.truncated === true) {
      return { kind: "none", reason: "devtools-truncated" };
    }
    if (!includeBody) return { kind: "none", reason: "omitted-by-choice" };
    if (isBlocked(latest) || isBlocked(request)) return { kind: "none", reason: "no-response" };
    // Never fetch getResponseContent while still downloading: Gecko emits partial chunks and does not set truncated until completion.
    if (isInProgress(latest)) return { kind: "none", reason: "in-progress" };
    if (liveStatus === 204 || liveStatus === 304) return { kind: "empty" };
    if (liveStatus === 0) return { kind: "none", reason: "no-response" };

    let packet: DevToolsResponseContentPacket | undefined = latest.responseContent;
    if (packet === undefined) {
      const client = api.connector.commands?.client;
      if (client === undefined) return { kind: "none", reason: "devtools-discarded" };
      const actorId = latest.id.replace("-clone", "");
      try {
        packet = (await client.request({
          to: actorId,
          type: "getResponseContent",
        })) as DevToolsResponseContentPacket;
      } catch {
        return {
          kind: "none",
          reason: isInProgress(latest) ? "in-progress" : "devtools-discarded",
        };
      }
    }

    const after = api.store.getState().requests.requests.find((r) => r.id === request.id);
    if (after?.truncated === true) return { kind: "none", reason: "devtools-truncated" };
    if (after !== undefined && isInProgress(after)) return { kind: "none", reason: "in-progress" };
    if (packet.contentDiscarded === true) return { kind: "none", reason: "devtools-discarded" };
    const text = packet.content?.text;
    const encoding: "base64" | null = packet.content?.encoding === "base64" ? "base64" : null;
    if (text === undefined || text === null || text === "") {
      if (missingContent(packet, after ?? latest)) {
        return {
          kind: "none",
          reason: isInProgress(after ?? latest) ? "in-progress" : "devtools-discarded",
        };
      }
      return { kind: "empty" };
    }
    if (typeof text === "string") {
      return {
        kind: "candidates",
        list: [
          {
            kind: "devtools",
            ref: registerHandle({ kind: "string", text }),
            encoding,
            length: text.length,
          },
        ],
      };
    }
    if (isLongStringGrip(text)) {
      const client = api.connector.commands?.client;
      if (client === undefined) return { kind: "none", reason: "devtools-discarded" };
      if (text.length === 0) return { kind: "empty" };
      return {
        kind: "candidates",
        list: [
          {
            kind: "devtools",
            ref: registerHandle({ kind: "grip", client, grip: text }),
            encoding,
            length: text.length,
          },
        ],
      };
    }
    return { kind: "none", reason: "devtools-discarded" };
  };

  const stubMaterial = async (
    api: NetMonitorApi,
    request: DevToolsRequestItem,
    includeBody: boolean,
  ): Promise<Material> => {
    const status = Number(request.status) || 0;
    const initiator = await initiatorFor(api, request);
    const wsMessages = await wsMessagesFor(api, request);
    const fromCache = fromCacheOf(request.fromCache);
    const resourceType = resourceTypeOf(request);
    const entry = buildHarEntry({
      startedDateTime: isoDateTimeFromEpochMs(Math.floor(request.startedMs)),
      request: {
        method: request.method,
        url: toHarUrl(request.url) ?? (request.url as HarUrl),
        httpVersion: request.httpVersion ?? "",
        headersSize: -1,
        bodySize: -1,
      },
      response: {
        status,
        statusText: request.statusText ?? "",
        httpVersion: request.httpVersion ?? "",
        content: { size: -1, mimeType: request.mimeType ?? "" },
        headersSize: -1,
        bodySize: typeof request.transferredSize === "number" ? request.transferredSize : -1,
        ...(typeof request.transferredSize === "number"
          ? { _transferSize: request.transferredSize }
          : {}),
      },
      timings: { send: -1, wait: -1, receive: -1 },
      ...(typeof request.remoteAddress === "string" && request.remoteAddress !== ""
        ? { serverIPAddress: request.remoteAddress }
        : {}),
      ...(request.remotePort !== undefined && request.remotePort !== ""
        ? { connection: String(request.remotePort) }
        : {}),
      ...(typeof request.securityState === "string"
        ? { _securityState: request.securityState }
        : {}),
      ...(initiator !== undefined ? { _initiator: initiator } : {}),
      ...(resourceType !== undefined ? { _resourceType: resourceType } : {}),
      ...(fromCache !== undefined ? { _fromCache: fromCache } : {}),
      ...(wsMessages !== undefined ? { _webSocketMessages: wsMessages } : {}),
    });
    const hasPost =
      request.requestPostDataAvailable === true ||
      request.requestPostData !== undefined ||
      request.method === "POST" ||
      request.method === "PUT" ||
      request.method === "PATCH";
    const latest =
      api.store.getState().requests.requests.find((r) => r.id === request.id) ?? request;
    return {
      entry,
      body:
        latest.truncated === true || request.truncated === true
          ? { kind: "none", reason: "devtools-truncated" }
          : !includeBody
            ? { kind: "none", reason: "omitted-by-choice" }
            : isBlocked(latest) || isBlocked(request)
              ? { kind: "none", reason: "no-response" }
              : isInProgress(latest)
                ? { kind: "none", reason: "in-progress" }
                : status === 0
                  ? { kind: "none", reason: "no-response" }
                  : { kind: "none", reason: "devtools-discarded" },
      upload: hasPost ? { kind: "none", reason: "devtools-discarded" } : { kind: "empty" },
    };
  };

  const entryFromBuilt = (
    built: Record<string, unknown>,
    request: DevToolsRequestItem,
    initiator: ChromeInitiator | undefined,
    wsMessages: readonly ChromeWebSocketMessage[] | undefined,
  ): HarEntry => {
    const rawReq = (built["request"] ?? {}) as Record<string, unknown>;
    const rawRes = (built["response"] ?? {}) as Record<string, unknown>;
    const rawContent = (rawRes["content"] ?? {}) as Record<string, unknown>;
    const rawPost = rawReq["postData"] as Record<string, unknown> | undefined;
    const rawStarted =
      typeof built["startedDateTime"] === "string" ? toIsoDateTime(built["startedDateTime"]) : null;
    const status = typeof rawRes["status"] === "number" ? rawRes["status"] : 0;
    const fromCache = fromCacheOf(request.fromCache);
    const resourceType = resourceTypeOf(request);
    const serverIp =
      typeof built["serverIPAddress"] === "string" && built["serverIPAddress"] !== ""
        ? built["serverIPAddress"]
        : typeof request.remoteAddress === "string" && request.remoteAddress !== ""
          ? request.remoteAddress
          : undefined;
    const connection =
      typeof built["connection"] === "string" && built["connection"] !== ""
        ? built["connection"]
        : request.remotePort !== undefined && request.remotePort !== ""
          ? String(request.remotePort)
          : undefined;
    const bodySize =
      typeof request.transferredSize === "number"
        ? request.transferredSize
        : typeof rawRes["bodySize"] === "number"
          ? rawRes["bodySize"]
          : -1;

    return buildHarEntry({
      startedDateTime: rawStarted ?? isoDateTimeFromEpochMs(Math.floor(request.startedMs)),
      request: {
        method: typeof rawReq["method"] === "string" ? rawReq["method"] : request.method,
        url:
          toHarUrl(typeof rawReq["url"] === "string" ? rawReq["url"] : request.url) ??
          (request.url as HarUrl),
        httpVersion:
          typeof rawReq["httpVersion"] === "string"
            ? rawReq["httpVersion"]
            : (request.httpVersion ?? ""),
        cookies: mapCookies(rawReq["cookies"]),
        headers: mapPairs(rawReq["headers"]),
        queryString: mapPairs(rawReq["queryString"]),
        ...(rawPost !== undefined
          ? {
              postData: {
                mimeType: typeof rawPost["mimeType"] === "string" ? rawPost["mimeType"] : "",
                params: mapParams(rawPost["params"]),
                text: "",
              },
            }
          : {}),
        headersSize: typeof rawReq["headersSize"] === "number" ? rawReq["headersSize"] : -1,
        bodySize: -1,
      },
      response: {
        status,
        statusText:
          typeof rawRes["statusText"] === "string"
            ? rawRes["statusText"]
            : (request.statusText ?? ""),
        httpVersion:
          typeof rawRes["httpVersion"] === "string"
            ? rawRes["httpVersion"]
            : (request.httpVersion ?? ""),
        cookies: mapCookies(rawRes["cookies"]),
        headers: mapPairs(rawRes["headers"]),
        content: {
          size: -1,
          mimeType:
            typeof rawContent["mimeType"] === "string"
              ? rawContent["mimeType"]
              : (request.mimeType ?? ""),
        },
        redirectURL: typeof rawRes["redirectURL"] === "string" ? rawRes["redirectURL"] : "",
        headersSize: typeof rawRes["headersSize"] === "number" ? rawRes["headersSize"] : -1,
        bodySize,
        ...(typeof request.transferredSize === "number"
          ? { _transferSize: request.transferredSize }
          : {}),
      },
      cache:
        typeof built["cache"] === "object" && built["cache"] !== null
          ? (built["cache"] as HarCache)
          : {},
      timings: mapTimings(built["timings"]),
      ...(serverIp !== undefined ? { serverIPAddress: serverIp } : {}),
      ...(connection !== undefined ? { connection } : {}),
      ...(typeof built["_securityState"] === "string"
        ? { _securityState: built["_securityState"] }
        : typeof request.securityState === "string"
          ? { _securityState: request.securityState }
          : {}),
      ...(typeof built["_priority"] === "string" ? { _priority: built["_priority"] } : {}),
      ...(initiator !== undefined ? { _initiator: initiator } : {}),
      ...(resourceType !== undefined ? { _resourceType: resourceType } : {}),
      ...(fromCache !== undefined ? { _fromCache: fromCache } : {}),
      ...(wsMessages !== undefined ? { _webSocketMessages: wsMessages } : {}),
    });
  };

  const prefetchMissingStacks = async (api: NetMonitorApi): Promise<void> => {
    if (prefetchedApis.has(api)) return;
    prefetchedApis.add(api);
    // Keep actions on while resolving stacks so FirefoxDataProvider caches frames in Redux (row D6)
    // even if a prior built-in HAR export left actionsEnabled false (M3).
    api.connector.enableActions(true);
    const targets: DevToolsRequestItem[] = [];
    for (const entry of held) {
      if (entry.api !== api) continue;
      const latest =
        api.store.getState().requests.requests.find((r) => r.id === entry.request.id) ??
        entry.request;
      const hasFrames = Array.isArray(latest.stacktrace) && latest.stacktrace.length > 0;
      if (!hasFrames && latest.cause?.stacktraceAvailable === true) targets.push(latest);
    }
    for (let i = 0; i < targets.length; i += STACK_PREFETCH_CHUNK) {
      const chunk = targets.slice(i, i + STACK_PREFETCH_CHUNK);
      await Promise.allSettled(chunk.map((req) => api.connector.requestData(req.id, "stackTrace")));
    }
  };

  const source: ExchangeSource = {
    name: "devtools",
    list: async (selection: ResolvedSelection): Promise<SourceListing> => {
      held.length = 0;
      const snapshots = capturedSnapshots;
      capturedSnapshots = null;
      const entries: CapturedToolbox[] =
        snapshots !== null
          ? snapshots
          : toolboxesForSelection(selection.tabId).flatMap((toolbox) => {
              const localTab = toolbox.commands?.descriptorFront?.localTab;
              if (localTab === undefined) return [];
              return [
                {
                  toolbox,
                  localTab,
                  tabKey: { run, browserId: localTab.linkedBrowser.browserId },
                  fallbackSite: siteOfUri(localTab.linkedBrowser.currentURI),
                  api: null,
                  requests: null,
                },
              ];
            });
      if (entries.length === 0) return { items: [], notNetwork: {} };

      const items: SourceItem[] = [];
      const notNetwork: Record<string, number> = {};
      const nonNetworkSelection: ResolvedSelection = { ...selection, include: "all" };

      for (const entry of entries) {
        const api = entry.api ?? (await apiOf(entry.toolbox));
        const requests = entry.requests ?? sortedRequests(api);
        const { tabKey, fallbackSite } = entry;

        let currentTopSite: Site | null = null;
        for (const request of requests) {
          if (request.isNavigationRequest === true) {
            const navSite = siteOfUrl(request.url);
            if (navSite !== null) currentTopSite = navSite;
          }
          const startedAt = Math.floor(request.startedMs) as EpochMs;
          const startedMinute = toMinute(startedAt);
          const site = currentTopSite ?? fallbackSite ?? siteOfUrl(request.url);
          const classified = classifyUrl(request.url);
          if (classified.kind !== "network") {
            if (
              inSelection(nonNetworkSelection, {
                startedMinute,
                tab: tabKey,
                site,
                fetchOrXhr: false,
              })
            ) {
              const bucket = classified.kind === "not-network" ? classified.scheme : "malformed";
              notNetwork[bucket] = (notNetwork[bucket] ?? 0) + 1;
            }
            continue;
          }

          const channelKey =
            request.resourceId !== undefined && request.resourceId !== null
              ? parseChannelKey(String(request.resourceId))
              : null;
          const key = channelKey === null ? null : exchangeId(run, channelKey);
          const item: SourceItem = {
            source: "devtools",
            key,
            startedAt,
            startedMinute,
            url: request.url,
            method: request.method,
            tab: tabKey,
            site,
            navigation: request.isNavigationRequest === true,
            fetchOrXhr:
              request.isXHR === true ||
              request.cause?.type === "xhr" ||
              request.cause?.type === "fetch",
            inProgress: request.totalTime === undefined && !isBlocked(request),
            ref: held.length as unknown as SourceRef,
          };
          if (!inSelection(selection, item)) continue;
          held.push({ api, request });
          items.push(item);
        }
      }

      return { items, notNetwork };
    },

    load: async (item, opts): Promise<Material> => {
      const found = held[item.ref as unknown as number];
      if (found === undefined) throw new Error("not an item of this DevTools listing");
      const { api, request } = found;
      await prefetchMissingStacks(api);
      const current =
        api.store.getState().requests.requests.find((r) => r.id === request.id) ?? request;
      const [initiator, wsMessages] = await Promise.all([
        initiatorFor(api, current),
        wsMessagesFor(api, current),
      ]);
      const { HarBuilder } = devtoolsModules();

      let builtEntry: Record<string, unknown> | undefined;
      // Pause Redux actions while HarBuilder reads metadata so each requestData avoids a 50 ms batch flush.
      api.connector.enableActions(false);
      try {
        const { responseContent: _ignoredContent, ...metadataItem } = current;
        const builder = new HarBuilder({
          connector: metadataConnector(api.connector),
          id: 1,
          includeResponseBodies: false,
          items: [metadataItem],
          supportsMultiplePages: false,
        });
        const built = await builder.build();
        builtEntry = built.log.entries[0];
      } catch {
        builtEntry = undefined;
      } finally {
        api.connector.enableActions(true);
      }

      if (builtEntry === undefined) {
        return stubMaterial(api, current, opts.body);
      }

      const entry = entryFromBuilt(builtEntry, current, initiator, wsMessages);
      const body = await resolveResponseBody(api, current, opts.body, entry.response.status);

      const latest =
        api.store.getState().requests.requests.find((r) => r.id === request.id) ?? request;
      const rawReq = (builtEntry["request"] ?? {}) as Record<string, unknown>;
      const rawPost = rawReq["postData"] as Record<string, unknown> | undefined;
      let upload: BodyCandidates = { kind: "empty" };
      if (latest.requestPostData?.postDataDiscarded === true) {
        upload = { kind: "none", reason: "devtools-discarded" };
      } else if (rawPost !== undefined) {
        const postText = rawPost["text"];
        if (typeof postText === "string" && postText.length > 0) {
          upload = {
            kind: "candidates",
            list: [
              {
                kind: "devtools",
                ref: registerHandle({ kind: "string", text: postText }),
                encoding: null,
                length: postText.length,
              },
            ],
          };
        }
      }

      return { entry, body, upload };
    },
  };

  const bodies: BodyReader = {
    open: async (sourceItem, chunkBytes, signal) => {
      if (sourceItem.kind !== "devtools") return { ok: false, reason: "source-error" };
      const handle = bodyRefs.get(sourceItem.ref);
      if (handle === undefined) return { ok: false, reason: "source-error" };
      if (handle.kind === "string") {
        const step = Math.max(1, chunkBytes);
        return {
          ok: true,
          body: {
            kind: "text",
            encoding: sourceItem.encoding,
            chunks: (async function* () {
              for (let offset = 0; offset < handle.text.length; offset += step) {
                if (signal.aborted) return;
                yield handle.text.slice(offset, offset + step);
              }
            })(),
          },
        };
      }

      const { client, grip } = handle;
      const sliceSize = Math.max(1, Math.min(chunkBytes, LONG_STRING_SLICE_CHARS));
      let nextOffset = grip.initial.length;
      let prefetched: string | null = null;
      if (nextOffset < grip.length) {
        if (signal.aborted) return { ok: false, reason: "source-error" };
        const end = Math.min(grip.length, nextOffset + sliceSize);
        try {
          const res = await client.request({
            to: grip.actor,
            type: "substring",
            start: nextOffset,
            end,
          });
          if (typeof res["substring"] !== "string") {
            return { ok: false, reason: "devtools-discarded" };
          }
          prefetched = res["substring"];
          nextOffset = end;
        } catch {
          return { ok: false, reason: "devtools-discarded" };
        }
      }

      return {
        ok: true,
        body: {
          kind: "text",
          encoding: sourceItem.encoding,
          chunks: (async function* () {
            if (grip.initial.length > 0) yield grip.initial;
            if (prefetched !== null && prefetched.length > 0) yield prefetched;
            while (nextOffset < grip.length) {
              if (signal.aborted) return;
              const end = Math.min(grip.length, nextOffset + sliceSize);
              const res = await client.request({
                to: grip.actor,
                type: "substring",
                start: nextOffset,
                end,
              });
              if (typeof res["substring"] !== "string") {
                throw new Error("LongStringActor substring returned no text");
              }
              nextOffset = end;
              yield res["substring"];
            }
          })(),
        },
      };
    },
  };

  return { source, bodies, firstMinute, snapshot };
}
