import { z } from "zod";

const bool = z.enum(["true", "false"]).transform(v => v === "true");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    APP_URL: z.url(),
    CORS_ORIGINS: z.string().default("").transform(s => s.split(",").map(o => o.trim()).filter(Boolean)),
    DATABASE_URL: z.string().startsWith("postgres"),
    REDIS_URL: z.string().startsWith("redis"),
    JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    ENCRYPTION_KEY: z
      .string()
      .refine(k => Buffer.from(k, "base64").length === 32, "ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
    SMS_PROVIDER: z.enum(["log"]).default("log"),
    EXPOSE_DEV_OTP: bool.default(false),
    RUN_WORKERS: bool.default(true),
    FILE_STORAGE_DIR: z.string().default(".data/files"),
    /** Where phones open "Scan with phone" links (default APP_URL; in development a localhost APP_URL becomes this computer's LAN address). */
    SCAN_LINK_ORIGIN: z.url().optional(),
    /** Local AI that reads scanned labels (Ollama, e.g. http://127.0.0.1:11434); unset = OCR + rules only. A vision model (default qwen2.5vl:3b) reads the photo itself; a text model reads the OCR text. */
    /** OCR languages for scanned labels: "eng" (English labels, fastest) or "eng+ben" (Bangla too). */
    SCAN_OCR_LANGS: z.string().regex(/^(eng|ben)(\+(eng|ben))*$/, "Use eng or eng+ben").default("eng"),
    SCAN_AI_URL: z.union([z.url(), z.literal("")]).optional(),
    SCAN_AI_MODEL: z.string().min(1).default("qwen2.5vl:3b"),
    SCAN_AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(600_000),
    /** Push notifications without the super admin setting (development): the Firebase service account JSON file. */
    FIREBASE_SERVICE_ACCOUNT_FILE: z.string().optional(),
    TRUST_PROXY: bool.default(false),
    AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    /** Road routing for route optimisation (OSRM HTTP API). The public demo server is for development only. */
    OSRM_URL: z.url().default("https://router.project-osrm.org"),
    OSRM_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(6000),
    /** Place search (OpenStreetMap Nominatim). The public server allows at most 1 request/second; self-host for volume. */
    NOMINATIM_URL: z.url().default("https://nominatim.openstreetmap.org"),
    /** Identifies the app to Nominatim, as its usage policy requires. */
    NOMINATIM_USER_AGENT: z.string().min(3).default("DeliveryFast/1.0 (+https://deliveryfast.example)"),
    NOMINATIM_EMAIL: z.email().optional(),
    NOMINATIM_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5000),
    /** Minimum milliseconds between upstream requests across all API instances. */
    NOMINATIM_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(1100),
    /** Country codes searched (ISO 3166-1 alpha-2, comma separated). */
    NOMINATIM_COUNTRY_CODES: z.string().default("bd"),
  })
  .refine(env => !(env.NODE_ENV === "production" && env.EXPOSE_DEV_OTP), {
    message: "EXPOSE_DEV_OTP must be false in production",
    path: ["EXPOSE_DEV_OTP"],
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Validated environment. Fails fast at startup with every problem listed. */
export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(i => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  cached = parsed.data;
  return cached;
}

export const isProduction = () => env().NODE_ENV === "production";

/**
 * Whether this process runs background jobs (pg-boss schedules and workers): API instances with
 * RUN_WORKERS=true (development), or the standalone worker process (`npm run worker`), which sets
 * DF_WORKER_PROCESS=1 before the app starts.
 */
export const runsJobs = () => process.env.DF_WORKER_PROCESS === "1" || env().RUN_WORKERS;
