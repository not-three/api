import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { version } from '../package.json';

process.on('SIGINT', () => {
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  app.useBodyParser('json', { limit: '10mb' });
  app.useBodyParser('text', { limit: '10mb' });

  if (process.env.DISABLE_SWAGGER !== 'true') {
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

  await app.listen(process.env.PORT ?? 4000);

  process.on('SIGINT', () => app.close().then(() => process.exit(0)));
}
bootstrap();
