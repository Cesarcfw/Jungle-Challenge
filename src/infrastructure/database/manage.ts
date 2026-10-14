import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from './config';

const command = process.argv[2];
if (!['up', 'down', 'check'].includes(command ?? '')) {
  throw new Error('Expected database command: up, down or check.');
}

const orm = await MikroORM.init(databaseConfig());
try {
  if (command === 'up') {
    await orm.getMigrator().up();
    console.log(JSON.stringify({ status: 'ok', action: 'migrate' }));
  } else if (command === 'down') {
    await orm.getMigrator().down();
    console.log(JSON.stringify({ status: 'ok', action: 'rollback' }));
  } else {
    await orm.em.getConnection().execute('select 1');
    console.log(JSON.stringify({ status: 'ok', postgres: 'reachable' }));
  }
} finally {
  await orm.close(true);
}
