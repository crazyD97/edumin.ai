import { buildApp } from './app';
import { env } from './core/env';
import { startJobs } from './jobs';

const app = await buildApp();
await app.listen({ port: env.PORT, host: '0.0.0.0' });
startJobs(app.log);
console.log(`API ready on http://localhost:${env.PORT}  ·  docs at http://localhost:${env.PORT}/api/docs`);
