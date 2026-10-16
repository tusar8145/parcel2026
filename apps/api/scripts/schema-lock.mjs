// Serialises database-schema changes while several people (or agents) work in parallel.
//
//   node scripts/schema-lock.mjs acquire <who>      wait for and take the lock (max 15 min)
//   node scripts/schema-lock.mjs migrate <name>     turn your schema edits into a migration, apply it, regenerate the client
//   node scripts/schema-lock.mjs release            give the lock back
//
// Edit prisma/schema/*.prisma only while holding the lock. `migrate` diffs the dev database
// against the schema, writes prisma/migrations/<timestamp>_<name>/migration.sql and applies it
// with `prisma migrate deploy`. It refuses changes that drop tables or columns (data loss);
// make those by hand with a reviewed migration.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lock = path.join(root, "prisma", ".schema-lock");
const [command, arg] = process.argv.slice(2);
const run = cmd => execSync(cmd, { cwd: root, stdio: "inherit" });
const capture = cmd => execSync(cmd, { cwd: root, stdio: ["ignore", "pipe", "inherit"] }).toString();
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (command === "acquire") {
  const who = arg ?? "unknown";
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner"), `${who} ${new Date().toISOString()}\n`);
      console.log(`Schema lock acquired by ${who}`);
      break;
    } catch {
      const owner = fs.existsSync(path.join(lock, "owner")) ? fs.readFileSync(path.join(lock, "owner"), "utf8").trim() : "?";
      const since = Date.parse(owner.split(" ")[1] ?? "");
      if (Number.isFinite(since) && Date.now() - since > 20 * 60_000) {
        console.log(`Breaking stale lock held by ${owner}`);
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for schema lock (held by ${owner})`);
      sleep(3000);
    }
  }
} else if (command === "migrate") {
  if (!fs.existsSync(lock)) throw new Error("Acquire the schema lock first");
  const name = (arg ?? "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "");
  if (!name) throw new Error("usage: migrate <name>");
  run("npx prisma validate");
  run("npx prisma migrate deploy"); // others' migrations first, so the diff only holds your change
  const sql = capture("npx prisma migrate diff --from-config-datasource --to-schema prisma/schema --script");
  if (!/\b(CREATE|ALTER|DROP)\b/.test(sql)) {
    console.log("No schema changes to migrate.");
  } else {
    const destructive = sql.match(/^\s*(DROP TABLE|ALTER TABLE .* DROP COLUMN|DROP TYPE).*/gim);
    if (destructive) throw new Error(`Refusing a migration that drops data:\n${destructive.join("\n")}`);
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const dir = path.join(root, "prisma", "migrations", `${stamp}_${name}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "migration.sql"), sql);
    console.log(`Wrote ${path.relative(root, dir)}/migration.sql`);
    run("npx prisma migrate deploy");
  }
  run("npx prisma generate");
} else if (command === "release") {
  fs.rmSync(lock, { recursive: true, force: true });
  console.log("Schema lock released");
} else {
  console.log("usage: node scripts/schema-lock.mjs acquire <who> | migrate <name> | release");
  process.exit(1);
}
