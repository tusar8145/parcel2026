import { z } from "zod";

/** Limits for the platform configuration document (Setting "platform-config"). */
export const PLATFORM_CONFIG_MAX_BYTES = 256 * 1024;
export const PLATFORM_CONFIG_MAX_DEPTH = 12;
export const PLATFORM_CONFIG_MAX_KEYS = 200;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Nesting depth of objects/arrays and the first forbidden key, in one walk. */
function inspect(value: unknown, depth = 1): { depth: number; badKey?: string } {
  const children = Array.isArray(value) ? value.map(v => ["", v] as const) : isPlainObject(value) ? Object.entries(value) : null;
  if (!children) return { depth: depth - 1 };
  let max = depth;
  for (const [key, item] of children) {
    if (FORBIDDEN_KEYS.has(key)) return { depth, badKey: key };
    const r = inspect(item, depth + 1);
    if (r.badKey) return r;
    max = Math.max(max, r.depth);
  }
  return { depth: max };
}

/**
 * Shared settings the web panels read (notification channels, service plans, rider plans,
 * catalogs…). Any JSON object, within size and shape limits.
 */
export const platformConfigSchema = z
  .custom<Record<string, unknown>>(isPlainObject, "Send the platform configuration as a JSON object")
  .superRefine((config, ctx) => {
    if (Object.keys(config).length > PLATFORM_CONFIG_MAX_KEYS)
      ctx.addIssue({ code: "custom", message: `Use at most ${PLATFORM_CONFIG_MAX_KEYS} top-level settings` });
    const bytes = Buffer.byteLength(JSON.stringify(config), "utf8");
    if (bytes > PLATFORM_CONFIG_MAX_BYTES)
      ctx.addIssue({ code: "custom", message: `The configuration is ${Math.ceil(bytes / 1024)} KB; the limit is ${PLATFORM_CONFIG_MAX_BYTES / 1024} KB` });
    const { depth, badKey } = inspect(config);
    if (badKey) ctx.addIssue({ code: "custom", message: `"${badKey}" can't be used as a setting name` });
    if (depth > PLATFORM_CONFIG_MAX_DEPTH) ctx.addIssue({ code: "custom", message: `Settings can be nested at most ${PLATFORM_CONFIG_MAX_DEPTH} levels deep` });
  });
export type PlatformConfig = Record<string, unknown>;
