// Every surface the recorder exposes, enumerated from its packed XPI and the running browser, and compared to the
// allowed set written here. A surface not in the set fails the check, so a new way in has to be added on purpose.

/** One extension page the recorder shows, as the system principal saw it in that page's process. */
export type PageSurface = {
  readonly href: string;
  /** Event types with a listener on the page's window, from the event listener service. */
  readonly windowListeners: readonly string[];
  readonly frames: number;
  /** What came back after the page posted a message to itself, or null when nothing but its own message arrived. */
  readonly echo: string | null;
};

export type ExposureEvidence = {
  readonly manifestKeys: readonly string[];
  readonly experimentApis: Readonly<Record<string, unknown>>;
  /** Every `allowedContexts` in the packed schemas, as `<file>: <json path> = <value>`. */
  readonly schemaContexts: readonly string[];
  readonly contentScripts: readonly unknown[];
  readonly background: unknown;
  readonly declaredWebAccessible: readonly unknown[];
  /** `extension.webAccessibleResources` as the running browser holds it, after seal and again at the end. */
  readonly runtimeWebAccessible: readonly (readonly unknown[])[];
  /** Packed files the running policy calls web accessible to a web page. */
  readonly webAccessiblePaths: readonly string[];
  /** `<file>: <name>` for every external messaging listener named in the packed scripts. */
  readonly externalListeners: readonly string[];
  readonly pages: readonly PageSurface[];
  /** Pages the recorder declares (popup, options) that the check opened and read. */
  readonly declaredPages: readonly string[];
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

/** Every surface outside the allowed set; empty when the recorder exposes only what it may. */
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
    ...e.runtimeWebAccessible
      .filter((resources) => resources.length > 0)
      .map((resources) => `runtime webAccessibleResources ${JSON.stringify(resources)}`),
    ...e.webAccessiblePaths.map((path) => `web accessible at runtime: ${path}`),
    ...e.externalListeners.map((l) => `external listener ${l}`),
    ...e.pages.flatMap(pageProblems),
    ...e.declaredPages
      .filter((href) => !e.pages.some((page) => page.href === href))
      .map((href) => `declared page ${href} was not read`),
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
