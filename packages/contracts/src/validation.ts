/**
 * Minimal runtime validators for desktop transport payloads.
 *
 * Every request that crosses a process boundary (renderer to Electron main,
 * main to the execution host) arrives as `unknown`. These combinators turn
 * that value into a typed parameter object or throw `ContractValidationError`
 * with the offending path. They are deliberately tiny and dependency-free so
 * the same code runs in the main process, the host process, and tests.
 *
 * Validators reject unknown object keys. A renderer that sends extra fields
 * is either out of date or misbehaving, and silently dropping data would hide
 * that mismatch.
 */

/** Raised when a transport payload does not match its contract. */
export class ContractValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path === "" ? "params" : path}: ${message}`);
    this.name = "ContractValidationError";
  }
}

/** Parses an unknown value into `T` or throws `ContractValidationError`. */
export type Validator<T> = (value: unknown, path: string) => T;

/** Bounded arrays prevent a renderer from requesting an unbounded file batch. */
export function array<T>(item: Validator<T>, maxLength: number): Validator<readonly T[]> {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > maxLength) throw new ContractValidationError(path, `expected an array of at most ${maxLength} items`);
    return value.map((entry, index) => item(entry, `${path}[${index}]`));
  };
}

/** Boolean flags accept no coercion from strings or numbers. */
export const boolean: Validator<boolean> = (value, path) => {
  if (typeof value !== "boolean") throw new ContractValidationError(path, "expected a boolean");
  return value;
};

export function integer(min: number, max: number): Validator<number> {
  return (value, path) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new ContractValidationError(path, `expected an integer between ${min} and ${max}`);
    return value;
  };
}

/** A non-empty, trimmed-length-checked string. */
export function text(options: { readonly maxLength?: number; readonly allowEmpty?: boolean } = {}): Validator<string> {
  const maxLength = options.maxLength ?? 4096;
  return (value, path) => {
    if (typeof value !== "string") {
      throw new ContractValidationError(path, "expected a string");
    }
    if (!options.allowEmpty && value.trim() === "") {
      throw new ContractValidationError(path, "must not be empty");
    }
    if (value.length > maxLength) {
      throw new ContractValidationError(path, `must be at most ${maxLength} characters`);
    }
    return value;
  };
}

/** One of a fixed set of string literals. */
export function oneOf<const T extends string>(choices: readonly T[]): Validator<T> {
  return (value, path) => {
    if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
      throw new ContractValidationError(path, `expected one of ${choices.join(", ")}`);
    }
    return value as T;
  };
}

/**
 * Marks an object field as optional. `undefined` and a missing key are both
 * accepted and produce an absent key in the output, which keeps results
 * compatible with `exactOptionalPropertyTypes`.
 */
export interface OptionalValidator<T> {
  readonly optional: true;
  readonly validate: Validator<T>;
}

export function optional<T>(validate: Validator<T>): OptionalValidator<T> {
  return { optional: true, validate };
}

type Shape = Record<string, Validator<unknown> | OptionalValidator<unknown>>;

type RequiredKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalValidator<unknown> ? never : K;
}[keyof S];
type OptionalKeys<S extends Shape> = Exclude<keyof S, RequiredKeys<S>>;

/** Output type of `object(shape)`, with optional keys marked `?`. */
export type ObjectOf<S extends Shape> = {
  readonly [K in RequiredKeys<S>]: S[K] extends Validator<infer T> ? T : never;
} & {
  readonly [K in OptionalKeys<S>]?: S[K] extends OptionalValidator<infer T> ? T : never;
};

/** A plain object with exactly the listed keys. */
export function object<S extends Shape>(shape: S): Validator<ObjectOf<S>> {
  return (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ContractValidationError(path, "expected an object");
    }
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (!(key in shape)) {
        throw new ContractValidationError(join(path, key), "unexpected field");
      }
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(shape)) {
      const fieldPath = join(path, key);
      if (isOptional(entry)) {
        if (input[key] !== undefined) {
          output[key] = entry.validate(input[key], fieldPath);
        }
      } else {
        output[key] = entry(input[key], fieldPath);
      }
    }
    return output as ObjectOf<S>;
  };
}

/** Validator for commands that take no parameters. */
export const empty: Validator<Record<string, never>> = object({}) as Validator<Record<string, never>>;

function isOptional(entry: Validator<unknown> | OptionalValidator<unknown>): entry is OptionalValidator<unknown> {
  return typeof entry === "object" && entry.optional;
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}
