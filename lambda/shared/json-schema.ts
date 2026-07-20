/**
 * Precise JSON Schema types derived from a TS type, so a schema literal
 * handed to `responseJsonSchema` can't drift from the type it's meant to
 * produce. OpenAI strict schemas have no notion of an optional property —
 * optionality is expressed as `T | null` in the TS type, which this turns
 * into a two-element `type` tuple and folds `null` into `enum`.
 */

type JsonSchemaNode<T> = null extends T
  ? JsonSchemaNullableLeaf<Exclude<T, null>>
  : JsonSchemaLeaf<T>;

type JsonSchemaLeaf<T> = [T] extends [string]
  ? { type: "string"; description?: string; enum?: readonly T[] }
  : [T] extends [number]
    ? { type: "number"; description?: string }
    : T extends readonly (infer E)[]
      ? { type: "array"; description?: string; items: JsonSchemaNode<E> }
      : T extends infer O extends object
        ? JsonSchemaObject<O>
        : never;

type JsonSchemaNullableLeaf<T> = [T] extends [string]
  ? { type: readonly ["string", "null"]; description?: string; enum?: readonly (T | null)[] }
  : [T] extends [number]
    ? { type: readonly ["number", "null"]; description?: string }
    : T extends readonly (infer E)[]
      ? { type: readonly ["array", "null"]; description?: string; items: JsonSchemaNode<E> }
      : never;

export type JsonSchemaObject<T extends object> = {
  type: "object";
  additionalProperties: false;
  properties: { [K in keyof T]: JsonSchemaNode<T[K]> };
  required: (keyof T)[];
};
