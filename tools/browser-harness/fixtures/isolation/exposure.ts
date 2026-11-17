// Every surface the recorder exposes, enumerated from its packed XPI and the running browser, and compared to the
// allowed set written here. A surface not in the set fails the check, so a new way in has to be added on purpose.
// The running browser is read twice, before the probes and after them; anything that changed in between fails too.

/** One extension page the recorder shows, as the system principal saw it in that page's process. */
export type PageSurface = {
  readonly href: string;
  /** Event types with a listener on the page's window, from the event listener service. */
  readonly windowListeners: readonly string[];
  readonly frames: number;
  /** What came back after the page was posted a message, or null when nothing but that message arrived. */
  readonly echo: string | null;
};

/** What the running browser shows of the recorder at one moment. */
export type RuntimeSurface = {
  /** `extension.webAccessibleResources` as the running browser holds it. */
  readonly webAccessibleResources: readonly unknown[];
  /** Packed files the running policy calls web accessible to a web page. */
  readonly webAccessiblePaths: readonly string[];
  /** Every enumerated resource:// substitution, as `resource://<name>/ -> <target>`. */
  readonly substitutions: readonly string[];
  /** Every enumerated chrome package, as `chrome://<pkg>/ -> <target>`. */
  readonly chromePackages: readonly string[];
  readonly pages: readonly PageSurface[];
};

export type ExposureEvidence = {
  readonly manifestKeys: readonly string[];
  readonly experimentApis: Readonly<Record<string, unknown>>;
  /** Every `allowedContexts` in the packed schemas, as `<file>: <json path> = <value>`. */
  readonly schemaContexts: readonly string[];
  readonly contentScripts: readonly unknown[];
  readonly background: unknown;
  readonly declaredWebAccessible: readonly unknown[];
  /** `<file>: <name>` for every external messaging listener named in the packed scripts. */
  readonly externalListeners: readonly string[];
  /** Every page the recorder packs or declares, as a moz-extension URL; each must be read at both moments. */
  readonly pageUrls: readonly string[];
  readonly start: RuntimeSurface;
  readonly end: RuntimeSurface;
};

/** The allowed set: what One-Click HAR may expose, and nothing else. */
export const ALLOWED_EXPOSURE = {
  manifestKeys: [
    "manifest_version",
    "name",
    "version",
    "description",
    "browser_specific_settings",
    "icons",
    "action",
    "options_ui",
    "experiment_apis",
  ],
  /** Each experiment API: a schema and a parent script in the parent process, callable from the add-on only. */
  experimentKeys: ["schema", "parent"],
  parentScopes: ["addon_parent"],
} as const;

const MESSAGE_EVENTS = new Set(["message", "messageerror"]);

function experimentProblems(apis: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.entries(apis).flatMap(([name, api]) => {
    if (typeof api !== "object" || api === null)
      return [`experiment_apis.${name} is not an object`];
    const record = api as Record<string, unknown>;
    const extraKeys = Object.keys(record).filter(
      (key) => !(ALLOWED_EXPOSURE.experimentKeys as readonly string[]).includes(key),
    );
    const parent = record["parent"] as { readonly scopes?: unknown } | undefined;
    const scopes = JSON.stringify(parent?.scopes ?? null);
    return [
      ...extraKeys.map((key) => `experiment_apis.${name}.${key}`),
      ...(scopes === JSON.stringify(ALLOWED_EXPOSURE.parentScopes)
        ? []
        : [`experiment_apis.${name}.parent.scopes ${scopes}`]),
    ];
  });
}

function pageProblems(page: PageSurface): readonly string[] {
  return [
    ...page.windowListeners
      .filter((type) => MESSAGE_EVENTS.has(type.replace(/:capture$/u, "")))
      .map((type) => `${page.href} listens for ${type}`),
    ...(page.frames > 0 ? [`${page.href} holds ${String(page.frames)} frames`] : []),
    ...(page.echo === null ? [] : [`${page.href} answered postMessage: ${page.echo}`]),
  ];
}

/** What the running browser exposed at one moment beyond the allowed set, each line prefixed with the moment. */
function runtimeProblems(
  moment: "start" | "end",
  surface: RuntimeSurface,
  pageUrls: readonly string[],
): readonly string[] {
  return [
    ...(surface.webAccessibleResources.length > 0
      ? [`runtime webAccessibleResources ${JSON.stringify(surface.webAccessibleResources)}`]
      : []),
    ...surface.webAccessiblePaths.map((path) => `web accessible at runtime: ${path}`),
    ...surface.pages.flatMap(pageProblems),
    ...pageUrls
      .filter((href) => !surface.pages.some((page) => page.href === href))
      .map((href) => `page ${href} was not read`),
  ].map((line) => `at ${moment}: ${line}`);
}

/** Every part of the running surface, as comparable lines, so a change between the two moments names what moved. */
const SURFACE_PARTS: readonly (readonly [string, (s: RuntimeSurface) => readonly unknown[]])[] = [
  ["webAccessibleResources", (s) => s.webAccessibleResources],
  ["webAccessiblePaths", (s) => s.webAccessiblePaths],
  ["substitutions", (s) => s.substitutions],
  ["chromePackages", (s) => s.chromePackages],
  ["pages", (s) => s.pages],
];

/** Everything that differs between the start and the end of the run, as `<part> gained|lost <item>`. */
export function surfaceChanges(start: RuntimeSurface, end: RuntimeSurface): readonly string[] {
  return SURFACE_PARTS.flatMap(([part, read]) => {
    const before = read(start).map((item) => JSON.stringify(item));
    const after = read(end).map((item) => JSON.stringify(item));
    return [
      ...after.filter((item) => !before.includes(item)).map((item) => `${part} gained ${item}`),
      ...before.filter((item) => !after.includes(item)).map((item) => `${part} lost ${item}`),
    ];
  }).map((line) => `during the run, ${line}`);
}

/** Every surface outside the allowed set, and every change during the run; empty when nothing else is exposed. */
export function exposureProblems(e: ExposureEvidence): readonly string[] {
  return [
    ...e.manifestKeys
      .filter((key) => !(ALLOWED_EXPOSURE.manifestKeys as readonly string[]).includes(key))
      .map((key) => `manifest key ${key}`),
    ...experimentProblems(e.experimentApis),
    ...e.schemaContexts.map((c) => `schema ${c}`),
    ...(e.contentScripts.length > 0 ? [`content scripts ${JSON.stringify(e.contentScripts)}`] : []),
    ...(e.background === null ? [] : [`background ${JSON.stringify(e.background)}`]),
    ...(e.declaredWebAccessible.length > 0
      ? [`web_accessible_resources ${JSON.stringify(e.declaredWebAccessible)}`]
      : []),
    ...e.externalListeners.map((l) => `external listener ${l}`),
    ...runtimeProblems("start", e.start, e.pageUrls),
    ...runtimeProblems("end", e.end, e.pageUrls),
    ...surfaceChanges(e.start, e.end),
  ];
}

/** Every `allowedContexts` anywhere in a parsed schema, as `<json path> = <value>`. */
export function schemaContexts(schema: unknown, path = "$"): readonly string[] {
  if (Array.isArray(schema))
    return schema.flatMap((item, i) => schemaContexts(item, `${path}[${String(i)}]`));
  if (typeof schema !== "object" || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) =>
    key === "allowedContexts"
      ? [`${path}.allowedContexts = ${JSON.stringify(value)}`]
      : schemaContexts(value, `${path}.${key}`),
  );
}
