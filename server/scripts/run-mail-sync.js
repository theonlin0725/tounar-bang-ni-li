import { getDb, closeDb } from '../src/db.js';
import { syncAllConnections, syncConnection } from '../src/modules/data-capture/mail/sync.js';

getDb();
const connectionId = process.argv.find((a) => a.startsWith('--connection='))?.split('=')[1] || null;
const results = connectionId ? [await syncConnection(connectionId)] : await syncAllConnections();
console.log(JSON.stringify(results, null, 2));
closeDb();
