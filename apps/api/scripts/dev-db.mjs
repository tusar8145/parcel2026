// Local PostgreSQL for development and tests (no Docker or system install needed).
// Data lives in apps/api/.data/postgres (gitignored). Production uses DATABASE_URL instead.
//   node scripts/dev-db.mjs          start (keeps running; Ctrl+C to stop)
import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve(import.meta.dirname, "../.data/postgres");
const port = Number(process.env.DEV_DB_PORT || 5433);
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "pairaexpress",
  password: "pairaexpress",
  port,
  persistent: true,
  // UTF-8 regardless of the OS locale (Windows defaults to WIN1252, which can't store ৳ or Bengali).
  initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-collate=C", "--lc-ctype=C"],
  onLog: () => {},
});

const fresh = !fs.existsSync(path.join(dataDir, "PG_VERSION"));
if (fresh) await pg.initialise();
await pg.start();
for (const name of ["pairaexpress", "pairaexpress_test"]) {
  try {
    await pg.createDatabase(name);
  } catch {
    /* already exists */
  }
}
console.log(`PostgreSQL ready on postgresql://pairaexpress:pairaexpress@localhost:${port}/pairaexpress`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
