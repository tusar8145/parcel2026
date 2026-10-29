import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import fastifyMultipart from "@fastify/multipart";
import { Logger } from "nestjs-pino";
import { randomUUID } from "node:crypto";
import { AppModule } from "./app.module";
import { env } from "./config/env";

const SUPPORT_BODY_LIMIT = 40 * 1024 * 1024;

/** Builds the configured app (used by main.ts and the e2e tests). */
export async function createApp(options: { logger?: boolean } = {}) {
  const config = env();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: config.TRUST_PROXY,
      bodyLimit: 5 * 1024 * 1024,
      // Honour an incoming x-request-id (from a gateway) so logs correlate across services.
      requestIdHeader: "x-request-id",
      genReqId: () => randomUUID(),
    }),
    { bufferLogs: true, logger: options.logger === false ? false : undefined },
  );
  if (options.logger !== false) app.useLogger(app.get(Logger));
  // Support tickets and replies carry up to 5 attachments of 5 MB as base64 data URLs (~33 MB of JSON);
  // every other route keeps the 5 MB request limit.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onRoute", route => {
      if (route.url.startsWith("/api/v1/support/tickets")) route.bodyLimit = SUPPORT_BODY_LIMIT;
      // Share files (Courier Operations): one file of up to 25 MB per request.
      if (route.url.startsWith("/api/v1/file-shares/public/")) route.bodyLimit = 26 * 1024 * 1024;
    });
  app.setGlobalPrefix("api/v1");
  app.enableShutdownHooks();
  await app.register(fastifyHelmet, { contentSecurityPolicy: false }); // JSON API; Swagger UI needs inline scripts
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: 5 * 1024 * 1024, files: 3 } });
  app.enableCors({
    origin: config.CORS_ORIGINS,
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-df-client", "x-request-id"],
    exposedHeaders: ["x-request-id"],
  });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Paira Express API")
      .setDescription("Parcels, tracking, riders, merchants, COD and support. Errors use { error: { code, message, details, requestId } }.")
      .setVersion("1.0")
      .addBearerAuth({ type: "http", scheme: "bearer", description: "Access token, or a merchant API key (df_live_…)" })
      .build(),
  );
  SwaggerModule.setup("api/docs", app, document, { jsonDocumentUrl: "api/docs/openapi.json" });
  return app;
}
