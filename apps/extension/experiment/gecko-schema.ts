declare const valueType: unique symbol;

interface GeckoInteger {
  readonly type: "integer";
  readonly minimum?: number;
}

/** A Gecko WebExtension schema type, tagged with the TypeScript type of the values it accepts. */
type SchemaType<T> = GeckoInteger & { readonly [valueType]?: T };

export type Parameter<T> = SchemaType<T> & { readonly name: string };

declare const resultType: unique symbol;

/** Carries a result type only. Gecko schemas cannot describe what an async function resolves to. */
export interface Result<T> {
  readonly [resultType]?: T;
}

export interface AsyncFunction<P extends ReadonlyArray<Parameter<unknown>>, R> {
  readonly parameters: P;
  readonly result: Result<R>;
}

export type ApiTable = Readonly<
  Record<string, AsyncFunction<ReadonlyArray<Parameter<unknown>>, unknown>>
>;

type Arguments<P> = { -readonly [K in keyof P]: P[K] extends Parameter<infer T> ? T : never };

/** The functions a table describes, as the extension calls them and as the parent script implements them. */
export type ApiFunctions<Table extends ApiTable> = {
  readonly [Name in keyof Table]: Table[Name] extends AsyncFunction<infer P, infer R>
    ? (...args: Arguments<P>) => Promise<R>
    : never;
};

/* @__NO_SIDE_EFFECTS__ */
export const integer = (
  name: string,
  constraints: { readonly minimum?: number } = {},
): Parameter<number> => ({
  name,
  type: "integer",
  ...constraints,
});

/* @__NO_SIDE_EFFECTS__ */
export const returns = <T>(): Result<T> => ({});

/* @__NO_SIDE_EFFECTS__ */
export const asyncFunction = <const P extends ReadonlyArray<Parameter<unknown>>, R>(
  parameters: P,
  result: Result<R>,
): AsyncFunction<P, R> => ({ parameters, result });

/** The `schema.json` Gecko loads for an experiment namespace, in the shape `Schemas.sys.mjs` parses. */
export const toGeckoSchema = (namespace: string, table: ApiTable) => [
  {
    namespace,
    functions: Object.entries(table).map(([name, { parameters }]) => ({
      name,
      type: "function",
      async: true,
      parameters,
    })),
  },
];
