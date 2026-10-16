// Background jobs (SLA monitor, scheduled reports, pickups, imports…) register only when this is set
// or RUN_WORKERS=true; see runsJobs() in config/env.ts. Set before any module is loaded.
process.env.DF_WORKER_PROCESS = "1";
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { WorkersService } from "./modules/notifications/workers.service";

/** Standalone worker process (production): `RUN_WORKERS=false` on API instances, `npm run worker` here. */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(WorkersService).start();
}

void bootstrap();
