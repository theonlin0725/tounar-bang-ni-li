import { config } from './config.js';
import { createServer } from './http.js';
import { registerRoutes } from './routes/index.js';
import { getDb, closeDb } from './db.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import {
  flushCloudPersistence, initCloudPersistence, markCloudSnapshotDirty
} from './cloud/persistence.js';

const persistence = await initCloudPersistence();
registerRoutes();
getDb();
// Persist a new database and every startup migration before serving. Restored
// snapshots can predate this release's schema/data migrations, so both paths flush.
if (persistence.enabled) {
  markCloudSnapshotDirty();
  await flushCloudPersistence();
}

const server = createServer();
server.listen(config.port, config.host, () => {
  const address = server.address();
  console.log(JSON.stringify({
    event: 'listening',
    host: config.host,
    port: address?.port,
    base_url: config.appBaseUrl,
    env: config.appEnv,
    mail_mode: config.mailMode,
    scheduler: config.enableScheduler,
    cloud_persistence: persistence.enabled,
    cloud_restored: persistence.restored
  }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ event: 'shutdown', signal }));
  stopScheduler();
  server.close(async () => {
    let exitCode = 0;
    try {
      await flushCloudPersistence();
    } catch (error) {
      exitCode = 1;
      console.error(JSON.stringify({ event: 'shutdown_persistence_failed', code: String(error?.code || 'CLOUD_PERSISTENCE_ERROR') }));
    }
    closeDb();
    process.exit(exitCode);
  });
  setTimeout(() => process.exit(1), 15000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (config.enableScheduler) {
  startScheduler();
}
