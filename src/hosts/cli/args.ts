/**
 * A small argument parser for the CLI: positionals, `--flag`, `--flag value`,
 * `--flag=value`, short aliases, and repeated flags collected in order.
 *
 * A flag takes a value only when it is listed in `values`; anything else that
 * starts with `-` is a boolean. That keeps `eddie list doc.adoc --json` and
 * `eddie reply doc.adoc 3 --author VP "text"` unambiguous without a schema per
 * command. A bare `--` ends flag parsing, so reply text may start with a dash.
 */
export interface ParsedArgs {
  positional: string[];
  /** Every value given for a value flag, in order. */
  values: Map<string, string[]>;
  /** Boolean flags that were present. */
  bools: Set<string>;
}

export interface ArgSpec {
  /** Long names (without `--`) that take a value. */
  values: readonly string[];
  /** Short or alternative names → their long name. */
  aliases?: Readonly<Record<string, string>>;
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[], spec: ArgSpec): ParsedArgs {
  const takes = new Set(spec.values);
  const out: ParsedArgs = { positional: [], values: new Map(), bools: new Set() };
  const canon = (name: string) => spec.aliases?.[name] ?? name;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    // A lone "-" is a positional: it means stdin.
    if (!a.startsWith("-") || a === "-" || /^-\d/.test(a)) {
      out.positional.push(a);
      continue;
    }
    const body = a.replace(/^--?/, "");
    const eq = body.indexOf("=");
    const name = canon(eq >= 0 ? body.slice(0, eq) : body);
    if (takes.has(name)) {
      let value: string | undefined;
      if (eq >= 0) value = body.slice(eq + 1);
      else value = argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      out.values.set(name, [...(out.values.get(name) ?? []), value]);
    } else {
      out.bools.add(name);
    }
  }
  return out;
}

/** The last value given for `name`, or undefined. */
export function str(a: ParsedArgs, name: string): string | undefined {
  const v = a.values.get(name);
  return v?.[v.length - 1];
}

/** Every value given for `name`. */
export function all(a: ParsedArgs, name: string): string[] {
  return a.values.get(name) ?? [];
}

export function has(a: ParsedArgs, name: string): boolean {
  return a.bools.has(name) || a.values.has(name);
}

/** A numeric flag; throws a usage error when it is not a number. */
export function num(a: ParsedArgs, name: string): number | undefined {
  const v = str(a, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number, got "${v}"`);
  return n;
}

/** Comma-separated and repeated values of `name`, flattened. */
export function list(a: ParsedArgs, name: string): string[] {
  return all(a, name)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}
