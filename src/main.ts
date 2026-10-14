import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from './infrastructure/database/config';
import { createApp } from './http/app';

const orm = await MikroORM.init(databaseConfig());
const app = await createApp(orm, { messaging: process.env.ENABLE_MESSAGING !== 'false' });
await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
console.log(JSON.stringify({ level: 'info', message: 'HTTP server listening', url: await app.getUrl() }));
