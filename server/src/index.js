import { config } from './config.js';
import { createServer } from './http.js';
import { registerRoutes } from './routes/index.js';
import { getDb, closeDb } from './db.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

registerRoutes();
getDb();

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
    scheduler: config.enableScheduler
  }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ event: 'shutdown', signal }));
  stopScheduler();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (config.enableScheduler) {
  startScheduler();
}
