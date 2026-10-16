import { config } from "dotenv";

// override: a DATABASE_URL in your shell must never point the tests (which truncate tables) at another database.
config({ path: ".env.test", override: true, quiet: true });
// Parallel test runs (e.g. CI shards) can each use their own database / Redis DB.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (process.env.TEST_REDIS_URL) process.env.REDIS_URL = process.env.TEST_REDIS_URL;
if (process.env.TEST_LOGS === "1") process.env.LOG_LEVEL = "error";
