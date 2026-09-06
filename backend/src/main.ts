import { createApp } from './createApp.js';

async function bootstrap() {
  const app = await createApp();
  await app.listen(process.env.PORT || 3001, '0.0.0.0');
}

async function main() {
  await bootstrap();
}

main().catch((err: Error) => {
  console.error('Error starting application', err);
  process.exit(1);
});
