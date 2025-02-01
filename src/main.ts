import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { version } from "../package.json";
import { BaseConfig, LOG_LEVEL } from "./config";
import { setServers } from "dns";
import * as dotenv from "dotenv";

process.on("SIGINT", () => {
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

process.on("SIGTERM", () => {
  process.exit(0);
});

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

  process.on("SIGINT", () => app.close().then(() => process.exit(0)));
}
bootstrap();
