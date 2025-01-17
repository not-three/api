import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { version } from '../package.json';
import { BaseConfig } from './types/config';

process.on('SIGINT', () => {
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

async function bootstrap() {
  const cfg = new BaseConfig();
  const logLevel = ['fatal', 'error', 'warn', 'log', 'debug', 'trace'];
  const currentLogLevel = logLevel.indexOf(cfg.logLevel);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: logLevel.slice(0, currentLogLevel + 1) as any,
  });

  if (cfg.cors.enabled)
    app.enableCors({
      origin: cfg.cors.origin,
      methods: cfg.cors.methods.split(',').map((m) => m.trim()),
      allowedHeaders: cfg.cors.headers.split(',').map((h) => h.trim()),
    });

  app.useBodyParser('json', { limit: '10mb' });
  app.useBodyParser('text', { limit: '10mb' });

  if (!cfg.swaggerDisabled) {
    const config = new DocumentBuilder()
      .setTitle('not-th.re')
      .setDescription(
        '!3 is a simple, secure and open source paste sharing platform.',
      )
      .setVersion(version)
      .build();
    const documentFactory = () => SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('swagger', app, documentFactory);
  }

  await app.listen(cfg.port);

  process.on('SIGINT', () => app.close().then(() => process.exit(0)));
}
bootstrap();
