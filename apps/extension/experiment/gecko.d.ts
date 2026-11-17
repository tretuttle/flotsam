// The globals Gecko's ExtensionCommon.sys.mjs puts in the sandbox that loads an experiment parent script.
// Only the members this parent script uses are declared.

declare const tabBrand: unique symbol;
/** A browser tab element in the parent process. Passed back to DevTools, and read for its browser. */
interface NativeTab {
  readonly [tabBrand]: true;
  readonly linkedBrowser: {
    readonly browserId: number;
    readonly currentURI: Uri | null;
    readonly browsingContext: { readonly usePrivateBrowsing: boolean } | null;
  };
}

interface ExtensionObject {
  readonly tabManager: {
    /** Throws an `ExtensionError` when no tab has this ID, or for a private tab this add-on may not see. */
    get(tabId: number): { readonly nativeTab: NativeTab };
  };
  readonly version: string;
  readonly manifest: { readonly name: string };
}

interface ExtensionContext {
  readonly extension: ExtensionObject;
}

declare class ExtensionAPI {
  readonly extension: ExtensionObject;
  /** Present only when the manifest's experiment entry lists `"events": ["startup"]`. */
  onStartup?(): void;
  /** true when the browser is closing; false for a disable, uninstall or update of this add-on. */
  onShutdown?(isAppShutdown: boolean): void;
  getAPI(context: ExtensionContext): Record<string, object>;
}

/** An XPCOM interface id. Members are the interface's constants. */
interface XpcomInterface {
  readonly name: string;
}

interface Principal {
  readonly isSystemPrincipal: boolean;
  readonly isContentPrincipal: boolean;
  readonly scheme: string;
  readonly asciiHost: string;
}

interface BrowsingContext {
  readonly browserId: number;
  readonly top: BrowsingContext;
  readonly currentWindowGlobal: { readonly documentURI: Uri | null } | null;
}

interface LoadInfo {
  readonly originAttributes: { readonly privateBrowsingId: number };
  readonly triggeringPrincipal: Principal;
  readonly loadingPrincipal: Principal | null;
  readonly browsingContextID: number;
  readonly browsingContext: BrowsingContext | null;
  readonly externalContentPolicyType: number;
}

interface Uri {
  readonly spec: string;
  QueryInterface(iface: XpcomInterface): { readonly file: LocalFile };
  readonly scheme: string;
  readonly asciiHost: string;
  schemeIs(scheme: string): boolean;
  resolve(relative: string): string;
}

interface HeaderVisitor {
  visitHeader(name: string, value: string): void;
}

/** nsIHttpChannel and the interfaces it is queried for here, flattened. A getter that can throw says so. */
interface HttpChannel {
  readonly channelId: number;
  readonly URI: Uri;
  readonly loadInfo: LoadInfo;
  readonly requestMethod: string;
  /** Throws before a response head arrived. */
  readonly responseStatus: number;
  readonly responseStatusText: string;
  readonly contentType: string;
  readonly contentLength: number;
  /** Throws when the response has no Content-Disposition. */
  readonly contentDisposition: number;
  readonly status: number;
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly remoteAddress: string;
  readonly uploadStream: InputStream | null;
  readonly asyncOpenTime: number;
  readonly domainLookupStartTime: number;
  readonly domainLookupEndTime: number;
  readonly connectStartTime: number;
  readonly connectEndTime: number;
  readonly secureConnectionStartTime: number;
  readonly requestStartTime: number;
  readonly responseStartTime: number;
  readonly responseEndTime: number;
  /** Throws for a header that is absent. */
  getResponseHeader(name: string): string;
  /** Throws for a header that is absent. */
  getRequestHeader(name: string): string;
  visitRequestHeaders(visitor: HeaderVisitor): void;
  visitResponseHeaders(visitor: HeaderVisitor): void;
  getRequestVersion(major: { value?: number }, minor: { value?: number }): void;
  getResponseVersion(major: { value?: number }, minor: { value?: number }): void;
  setNewListener(listener: StreamListener): StreamListener;
  QueryInterface(iface: XpcomInterface): HttpChannel;
}

interface RequestObserver {
  onStartRequest(request: unknown): void;
  onStopRequest(request: unknown, status: number): void;
}
/** Opaque: a listener is only handed back to the tee. */
interface StreamListener {
  readonly __streamListener: true;
}

interface InputStream {
  readonly __inputStream: true;
  available(): number;
  close(): void;
}
interface SeekableStream extends InputStream {
  tell(): number;
  seek(whence: number, offset: number): void;
}
interface OutputStream {
  readonly __outputStream: true;
  write(data: string, count: number): number;
  close(): void;
}
interface StorageStream {
  readonly length: number;
  init(segmentSize: number, maxSize: number): void;
  getOutputStream(start: number): OutputStream;
  newInputStream(start: number): InputStream;
}
interface StreamListenerTee extends StreamListener {
  init(listener: StreamListener, sink: OutputStream, observer: RequestObserver): void;
}
interface FileOutputStream extends OutputStream {
  init(file: LocalFile, ioFlags: number, perm: number, behaviorFlags: number): void;
}
interface LocalFile {
  readonly path: string;
  readonly fileSize: number;
  permissions: number;
  initWithPath(path: string): void;
  exists(): boolean;
  create(type: number, permissions: number): void;
  moveTo(parent: LocalFile | null, name: string): void;
  readonly diskSpaceAvailable: number;
  /** lstat: true for a link, dangling or not. Throws when nothing is at the path. */
  isSymlink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
  /** Resolves every link (realpath). A path that does not exist is left as it is. */
  normalize(): void;
  /** Throws where the platform's file manager cannot select a file (row P4). */
  reveal(): void;
  launch(): void;
}
interface FileInputStream extends InputStream {
  init(file: LocalFile, ioFlags: number, perm: number, behaviorFlags: number): void;
}
interface MultiplexInputStream extends InputStream {
  appendStream(stream: InputStream): void;
}
interface ArrayBufferInputStream extends InputStream {
  setData(buffer: ArrayBuffer, byteOffset: number, length: number): void;
}
interface AsyncStreamCopier {
  init(
    source: InputStream,
    sink: OutputStream,
    target: unknown,
    sourceBuffered: boolean,
    sinkBuffered: boolean,
    chunkSize: number,
    closeSource: boolean,
    closeSink: boolean,
  ): void;
  asyncCopy(observer: RequestObserver, context: null): void;
}
interface Timer {
  initWithCallback(callback: { notify(): void }, delayMs: number, type: number): void;
  cancel(): void;
}

interface XpcomClasses {
  "@mozilla.org/storagestream;1": StorageStream;
  "@mozilla.org/network/stream-listener-tee;1": StreamListenerTee;
  "@mozilla.org/network/file-output-stream;1": FileOutputStream;
  "@mozilla.org/network/file-input-stream;1": FileInputStream;
  "@mozilla.org/file/local;1": LocalFile;
  "@mozilla.org/io/multiplex-input-stream;1": MultiplexInputStream;
  "@mozilla.org/io/arraybuffer-input-stream;1": ArrayBufferInputStream;
  "@mozilla.org/network/async-stream-copier;1": AsyncStreamCopier;
  "@mozilla.org/timer;1": Timer;
  "@mozilla.org/binaryinputstream;1": BinaryInputStream;
  "@mozilla.org/intl/converter-output-stream;1": ConverterOutputStream;
}

interface ConverterOutputStream {
  init(stream: OutputStream, charset: string): void;
  /** false when not every character was written. */
  writeString(text: string): boolean;
  close(): void;
}

interface BinaryInputStream {
  setInputStream(stream: InputStream): void;
  readArrayBuffer(count: number, buffer: ArrayBuffer): number;
}

/** What `asyncConvertData` returns: a listener that takes the coded bytes. Request arguments may be null. */
interface StreamConverter {
  onStartRequest(request: null): void;
  onDataAvailable(request: null, stream: InputStream, offset: number, count: number): void;
  onStopRequest(request: null, status: number): void;
}

declare const Cc: {
  readonly [Contract in keyof XpcomClasses]: {
    createInstance(iface: XpcomInterface): XpcomClasses[Contract];
  };
} & {
  readonly "@mozilla.org/network/stream-transport-service;1": {
    getService(iface: XpcomInterface): unknown;
  };
  readonly "@mozilla.org/security/random-generator;1": {
    getService(iface: XpcomInterface): { generateRandomBytes(length: number): number[] };
  };
  readonly "@mozilla.org/streamConverters;1": {
    getService(iface: XpcomInterface): {
      asyncConvertData(from: string, to: string, listener: object, context: null): StreamConverter;
    };
  };
  readonly "@mozilla.org/widget/clipboardhelper;1": {
    getService(iface: XpcomInterface): { copyString(text: string): void };
  };
};

declare const Ci: {
  readonly nsIHttpChannel: XpcomInterface;
  readonly nsIHttpChannelInternal: XpcomInterface;
  readonly nsITraceableChannel: XpcomInterface;
  readonly nsITimedChannel: XpcomInterface;
  readonly nsIUploadChannel: XpcomInterface;
  readonly nsIStorageStream: XpcomInterface;
  readonly nsIStreamListenerTee: XpcomInterface;
  readonly nsIFileOutputStream: XpcomInterface;
  readonly nsIFileInputStream: XpcomInterface;
  readonly nsIFileURL: XpcomInterface;
  readonly nsIFile: XpcomInterface;
  readonly nsIMultiplexInputStream: XpcomInterface;
  readonly nsIArrayBufferInputStream: XpcomInterface;
  readonly nsIAsyncStreamCopier: XpcomInterface;
  readonly nsIEventTarget: XpcomInterface;
  readonly nsIInputStream: XpcomInterface;
  readonly nsISeekableStream: XpcomInterface & { readonly NS_SEEK_SET: number };
  readonly nsISubstitutingProtocolHandler: XpcomInterface;
  readonly nsIRandomGenerator: XpcomInterface;
  readonly nsIBinaryInputStream: XpcomInterface;
  readonly nsIStreamConverterService: XpcomInterface;
  readonly nsIClipboardHelper: XpcomInterface;
  readonly nsIConverterOutputStream: XpcomInterface;
  readonly nsITimer: XpcomInterface & {
    readonly TYPE_ONE_SHOT: number;
    readonly TYPE_REPEATING_SLACK: number;
  };
  readonly nsIChannel: XpcomInterface & { readonly DISPOSITION_ATTACHMENT: number };
};

declare const Components: {
  isSuccessCode(status: number): boolean;
};

interface Observer {
  observe(subject: unknown, topic: string, data: string | null): void;
}

interface SubstitutingProtocolHandler {
  hasSubstitution(root: string): boolean;
  getSubstitution(root: string): Uri;
  resolveURI(uri: Uri): string;
}

interface FileDirectoryService {
  get(key: string, iface: XpcomInterface): LocalFile;
}

declare const Services: {
  readonly appinfo: {
    readonly name: string;
    readonly version: string;
    readonly appBuildID: string;
    readonly OS: string;
  };
  readonly obs: {
    addObserver(observer: Observer, topic: string): void;
    removeObserver(observer: Observer, topic: string): void;
  };
  readonly prefs: {
    getBoolPref(name: string, fallback: boolean): boolean;
  };
  readonly env: {
    get(name: string): string;
    exists(name: string): boolean;
  };
  readonly dirsvc: FileDirectoryService;
  readonly tm: { dispatchToMainThread(run: () => void): void };
  readonly eTLD: {
    getBaseDomainFromHost(host: string): string;
  };
  readonly io: {
    newURI(spec: string): Uri;
    getProtocolHandler(scheme: string): {
      QueryInterface(iface: XpcomInterface): SubstitutingProtocolHandler;
    };
  };
};

interface DevToolsToolbox {
  readonly hostType: string;
}

interface ShutdownPhase {
  /** Throws when the phase has already begun. */
  addBlocker(name: string, condition: Promise<unknown>): void;
}

interface NetUtilModule {
  readInputStream(stream: InputStream, count: number): ArrayBuffer;
  readInputStreamToString(
    stream: InputStream,
    count: number,
    options?: { readonly charset?: string },
  ): string;
}

interface GeckoModules {
  "chrome://devtools-startup/content/DevToolsShim.sys.mjs": {
    readonly DevToolsShim: { isInitialized(): boolean };
  };
  "resource://devtools/shared/loader/Loader.sys.mjs": {
    require(id: "resource://devtools/client/framework/devtools.js"): {
      readonly gDevTools: { getToolboxForTab(tab: NativeTab): DevToolsToolbox | undefined };
    };
  };
  "resource://gre/modules/NetUtil.sys.mjs": { readonly NetUtil: NetUtilModule };
  "resource://gre/modules/Downloads.sys.mjs": {
    readonly Downloads: { getPreferredDownloadsDirectory(): Promise<string> };
  };
  "resource://gre/modules/ExtensionUtils.sys.mjs": {
    readonly ExtensionUtils: { readonly ExtensionError: new (message: string) => Error };
  };
  "resource://gre/modules/AsyncShutdown.sys.mjs": {
    readonly AsyncShutdown: {
      readonly profileBeforeChange: ShutdownPhase;
      readonly sendTelemetry: ShutdownPhase;
    };
  };
}

declare const ChromeUtils: {
  importESModule<Url extends keyof GeckoModules>(url: Url): GeckoModules[Url];
  getXPCOMErrorName(status: number): string;
  now(): number;
  generateQI(interfaces: readonly string[]): unknown;
};

interface IOUtilsStat {
  readonly type: "regular" | "directory" | "other";
  readonly size: number;
  readonly permissions: number;
}

declare const IOUtils: {
  read(
    path: string,
    options?: { readonly maxBytes?: number; readonly offset?: number },
  ): Promise<Uint8Array>;
  readUTF8(path: string): Promise<string>;
  write(
    path: string,
    data: Uint8Array,
    options?: {
      readonly mode?: "overwrite" | "append" | "appendOrCreate" | "create";
      readonly tmpPath?: string;
    },
  ): Promise<number>;
  writeUTF8(
    path: string,
    text: string,
    options?: {
      readonly mode?: "overwrite" | "append" | "appendOrCreate" | "create";
      readonly tmpPath?: string;
    },
  ): Promise<number>;
  move(from: string, to: string, options?: { readonly noOverwrite?: boolean }): Promise<void>;
  remove(
    path: string,
    options?: { readonly recursive?: boolean; readonly ignoreAbsent?: boolean },
  ): Promise<void>;
  makeDirectory(
    path: string,
    options?: {
      readonly createAncestors?: boolean;
      readonly ignoreExisting?: boolean;
      readonly permissions?: number;
    },
  ): Promise<void>;
  setPermissions(path: string, permissions: number): Promise<void>;
  stat(path: string): Promise<IOUtilsStat>;
  exists(path: string): Promise<boolean>;
  getChildren(path: string, options?: { readonly ignoreAbsent?: boolean }): Promise<string[]>;
};

declare const PathUtils: {
  join(...segments: string[]): string;
  filename(path: string): string;
  parent(path: string): string | null;
  readonly profileDir: string;
};
