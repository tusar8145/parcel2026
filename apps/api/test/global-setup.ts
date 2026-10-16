import { execSync } from "node:child_process";
import { config } from "dotenv";

/** Brings the test database to the latest migration once per run. */
export default function setup() {
  const env = { ...process.env, ...config({ path: ".env.test", override: true, quiet: true }).parsed };
  if (process.env.TEST_DATABASE_URL) env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  execSync("npx prisma migrate deploy", { stdio: "pipe", env });
}
