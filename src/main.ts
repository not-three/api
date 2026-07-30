import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { version } from "../package.json";
import { BaseConfig, LOG_LEVEL } from "./config";
import { setServers } from "dns";
import * as dotenv from "dotenv";

// How long a graceful shutdown may take before the process is killed anyway.
const SHUTDOWN_GRACE_MS = 5000;

let closeApp: (() => Promise<void>) | null = null;
let shuttingDown = false;

// Closing the nest app runs the onModuleDestroy hooks, which is what flushes
// the valkey write buffer to the database in 'hard' request optimization mode.
// Both SIGINT and SIGTERM (what `docker stop` sends) have to go through here,
// otherwise buffered notes stay in valkey until the next start.
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Hard fallback so a hanging shutdown cannot wedge the container. Unref'd,
  // so it never keeps the process alive once the close is done.
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  if (!closeApp) return process.exit(0);
  closeApp().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function bootstrap() {
  if (!new BaseConfig().disableEnv) dotenv.config();
  const cfg = new BaseConfig();

  if (cfg.dnsServer) setServers([cfg.dnsServer]);

  const currentLogLevel = LOG_LEVEL.indexOf(cfg.logLevel);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: LOG_LEVEL.slice(0, currentLogLevel + 1) as any,
  });

  if (cfg.cors.enabled)
    app.enableCors({
      origin: cfg.cors.origin,
      methods: cfg.cors.methods.split(",").map((m) => m.trim()),
      allowedHeaders: cfg.cors.headers.split(",").map((h) => h.trim()),
    });

  app.useBodyParser("json", { limit: "10mb" });
  app.useBodyParser("text", { limit: "10mb" });

  if (!cfg.swaggerDisabled) {
    const config = new DocumentBuilder()
      .setTitle("not-th.re")
      .setDescription(
        "!3 is a simple, secure and open source paste sharing platform.",
      )
      .setVersion(version)
      .addBearerAuth()
      .build();
    const documentFactory = () => SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("swagger", app, documentFactory);
  }

  await app.listen(cfg.port);

  closeApp = () => app.close();
}
bootstrap();
