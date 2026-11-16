// Values in the exact form the file will contain. Only the export's redaction port produces them.

declare const written: unique symbol;
export type Written<T> = T & { readonly [written]: true };

/** A URL as written: the entry's request.url and every page title built from it. */
export type WrittenUrl = Written<string>;
/** A small JSON or form body after redaction, written in one piece. */
export type WrittenBody = Written<Uint8Array>;

/** The redaction place names the file's report lists as covered. Page titles are a place like any other. */
export type WrittenPlace =
  | "url"
  | "headers"
  | "cookies"
  | "query"
  | "post-data"
  | "json-body"
  | "form-body"
  | "page-title";
