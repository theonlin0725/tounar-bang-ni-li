import { getDb, closeDb } from '../src/db.js';
import { runReminders } from '../src/modules/mail-push/reminders.js';

getDb();
const ownerId = process.argv.find((a) => a.startsWith('--owner='))?.split('=')[1] || null;
const results = await runReminders(new Date(), { force: true, ownerId });
console.log(JSON.stringify(results, null, 2));
closeDb();
