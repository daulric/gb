import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';

let app: NestFastifyApplication;

async function ensureApp(env: Record<string, string>) {
  if (app) return app;

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') process.env[key] = value;
  }

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger: false },
  );

  // Register cookie plugin so the Supabase SSR adapter can read/write
  // session cookies. Without this, every cookie write silently drops
  // and sessions break on this entrypoint.
  await app.register(cookie);

  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Version'],
  });

  await app.init();
  return app;
}

export default {
  async fetch(
    request: Request,
    env: Record<string, string>,
  ): Promise<Response> {
    const nestApp = await ensureApp(env);
    const fastify = nestApp.getHttpAdapter().getInstance();

    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const body = ['GET', 'HEAD'].includes(request.method)
      ? undefined
      : Buffer.from(await request.arrayBuffer());

    const res = await fastify.inject({
      method: request.method as any,
      url: url.pathname + url.search,
      headers,
      payload: body,
    });

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
      if (value != null)
        responseHeaders.set(
          key,
          Array.isArray(value) ? value.join(', ') : String(value),
        );
    }

    return new Response(res.body, {
      status: res.statusCode,
      headers: responseHeaders,
    });
  },
};
