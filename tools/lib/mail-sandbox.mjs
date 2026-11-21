/*
 * Local SMTP + IMAP sandbox for the mail end-to-end benchmark.
 *
 * This intentionally implements only the protocol surface used by the production
 * client (nodemailer SMTP client + ImapFlow read-only sync). It never touches a
 * real mailbox and stores everything in memory.
 */
import net from 'node:net';
import libmime from 'libmime';
import libqp from 'libqp';

const CRLF = '\r\n';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function quote(value) {
  const text = String(value ?? '');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function encodeHeader(value) {
  return String(value ?? '');
}
function headerMap(rawHeaders = '') {
  const map = {};
  const lines = rawHeaders.replace(/\r\n?/g, '\n').split('\n');
  let last = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && last) { map[last] += ` ${line.trim()}`; continue; }
    const at = line.indexOf(':');
    if (at <= 0) continue;
    last = line.slice(0, at).toLowerCase();
    map[last] = line.slice(at + 1).trim();
  }
  return map;
}
function splitHeaderBody(raw) {
  const text = String(raw).replace(/\r\n?/g, '\n');
  const at = text.indexOf('\n\n');
  return at < 0 ? { headers: headerMap(text), body: '' } : { headers: headerMap(text.slice(0, at)), body: text.slice(at + 2) };
}
function rawHeadersFor(raw) {
  const text = String(raw).replace(/\r\n?/g, '\n');
  const at = text.indexOf('\n\n');
  return at < 0 ? text : text.slice(0, at);
}
function decodeTransfer(body, encoding = '') {
  const value = String(encoding || '').toLowerCase();
  if (value === 'base64') return Buffer.from(String(body).replace(/\s+/g, ''), 'base64').toString('utf8');
  if (value === 'quoted-printable') return libqp.decode(String(body)).toString('utf8');
  return String(body);
}
function parseAddress(value) {
  const text = libmime.decodeWords(String(value || '').trim());
  const angle = text.match(/^(.*?)\s*<([^>]+)>$/);
  if (angle) return { name: angle[1].trim().replace(/^"|"$/g, ''), address: angle[2].trim().toLowerCase() };
  return { name: '', address: text.replace(/^<|>$/g, '').toLowerCase() };
}
function parseMime(raw) {
  const { headers, body } = splitHeaderBody(raw);
  const contentType = String(headers['content-type'] || 'text/plain; charset=UTF-8');
  const type = contentType.split(';')[0].trim().toLowerCase();
  const boundary = contentType.match(/boundary\s*=\s*"?([^";]+)"?/i)?.[1] || null;
  const encoding = headers['content-transfer-encoding'] || '7bit';
  const makePart = (partType, partBody, path) => ({
    path,
    type: partType,
    body: decodeTransfer(partBody.replace(/\n$/, ''), encoding),
  });
  if (type.startsWith('multipart/') && boundary) {
    const chunks = String(body).split(`--${boundary}`);
    const parts = [];
    for (const chunk of chunks.slice(1)) {
      if (chunk.startsWith('--')) break;
      const partRaw = chunk.replace(/^\n/, '').replace(/\n$/, '');
      if (!partRaw.trim()) continue;
      const headEnd = partRaw.indexOf('\n\n');
      const partHeaders = headEnd < 0 ? '' : partRaw.slice(0, headEnd);
      const partBody = headEnd < 0 ? '' : partRaw.slice(headEnd + 2);
      const subType = String(headerMap(partHeaders)['content-type'] || 'text/plain').split(';')[0].trim().toLowerCase();
      const subEncoding = headerMap(partHeaders)['content-transfer-encoding'] || '7bit';
      parts.push({
        path: String(parts.length + 1),
        type: subType,
        body: decodeTransfer(partBody.replace(/\n$/, ''), subEncoding),
      });
    }
    return { headers, rawHeaders: rawHeadersFor(raw), type, boundary, parts };
  }
  const part = makePart(type, body, null);
  return { headers, rawHeaders: rawHeadersFor(raw), type, boundary: null, parts: [part] };
}

function imapDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '01-Jan-2026 00:00:00 +0000';
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} `
    + `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:`
    + `${String(d.getUTCSeconds()).padStart(2, '0')} +0000`;
}
function lineCount(text) {
  return String(text || '').split('\n').length;
}
function bodystructure(message) {
  const parts = message.parts;
  const child = (part) => {
    const subtype = part.type.split('/')[1] || 'plain';
    const size = Buffer.byteLength(part.body, 'utf8');
    return `("${part.type.split('/')[0].toUpperCase()}" "${subtype.toUpperCase()}" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${size} ${lineCount(part.body)})`;
  };
  // A single-part message is advertised as a one-child multipart. This keeps
  // ImapFlow on the normal part-number path (part "1"); the production client's
  // special single-node path is not needed by the sandbox.
  const children = parts.length ? parts : [{ type: 'text/plain', body: '' }];
  return `(${children.map(child).join(' ')} "ALTERNATIVE" ("BOUNDARY" ${quote(message.boundary || 'bench')}))`;
}
function envelope(message) {
  const from = parseAddress(message.headers.from || '');
  const to = [parseAddress(message.headers.to || '')];
  const addr = (item) => `(${quote(encodeHeader(item.name || ''))} NIL ${quote(item.address.split('@')[0] || '')} ${quote(item.address.split('@')[1] || '')})`;
  const list = (items) => `(${items.map(addr).join(' ')})`;
  return `(${quote(message.headers.date || imapDate(message.date))} ${quote(encodeHeader(message.subject))} ${list([from])} ${list([from])} ${list([from])} ${list(to)} NIL NIL NIL ${quote(message.messageId || '')})`;
}
function findPart(message, section) {
  const key = String(section || '').toLowerCase();
  if (!key || key === 'text') return message.parts[0] || null;
  const exact = message.parts.find((part) => part.path === key);
  if (exact) return exact;
  const numeric = key.replace(/\..*$/, '');
  return message.parts.find((part) => part.path === numeric) || (message.parts.length === 1 ? message.parts[0] : null);
}
function parseSearchDate(value) {
  const match = String(value || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[2]);
  if (month < 0) return null;
  return Date.UTC(Number(match[3]), month, Number(match[1]));
}
function commandParts(line) {
  // Enough for the commands used here (no client literals).
  const tokens = [];
  const re = /"((?:\\.|[^"])*)"|([^\s()]+)|([()])/g;
  let match;
  while ((match = re.exec(line))) {
    if (match[1] != null) tokens.push(match[1].replace(/\\(.)/g, '$1'));
    else if (match[2] != null) tokens.push(match[2]);
    else tokens.push(match[3]);
  }
  return tokens;
}
function parseRange(range, messages, uidMode) {
  const ids = [];
  const max = messages.length;
  for (const piece of String(range || '').split(',')) {
    const [a, b] = piece.split(':');
    const start = a === '*' ? (uidMode ? messages.at(-1)?.uid || 1 : max) : Number(a);
    const end = b === '*' ? (uidMode ? messages.at(-1)?.uid || start : max) : Number(b || a);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    for (const message of messages) {
      const key = uidMode ? message.uid : message.seq;
      if (key >= lo && key <= hi) ids.push(message);
    }
  }
  return [...new Map(ids.map((message) => [message.uid, message])).values()];
}

export async function startMailSandbox() {
  const messages = [];
  let nextUid = 1;
  const smtp = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    socket.setEncoding('utf8');
    socket.write(`220 localhost ESMTP bench\r\n`);
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          const raw = data.replace(/\r\n\.\./g, '\r\n.');
          const parsed = parseMime(raw);
          const headers = parsed.headers;
          const subject = libmime.decodeWords(headers.subject || '');
          const date = Date.parse(headers.date || '') || Date.now();
          messages.push({
            uid: nextUid++,
            seq: messages.length + 1,
            raw,
            headers,
            subject,
            date,
            messageId: headers['message-id'] || `<bench-${messages.length + 1}@local>`,
            ...parsed,
          });
          data = '';
          inData = false;
          socket.write('250 2.0.0 queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const upper = line.toUpperCase();
        if (upper === 'DATA') { inData = true; data = ''; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); continue; }
        if (upper.startsWith('EHLO')) {
          socket.write('250-localhost\r\n250-SIZE 104857600\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 PIPELINING\r\n');
        } else if (upper.startsWith('HELO')) socket.write('250 localhost\r\n');
        else if (upper.startsWith('MAIL FROM')) socket.write('250 2.1.0 Ok\r\n');
        else if (upper.startsWith('RCPT TO')) socket.write('250 2.1.5 Ok\r\n');
        else if (upper === 'RSET' || upper === 'NOOP') socket.write('250 Ok\r\n');
        else if (upper === 'QUIT') { socket.end('221 Bye\r\n'); return; }
        else socket.write('250 Ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  const imap = net.createServer((socket) => {
    let buffer = '';
    let selected = false;
    socket.setEncoding('utf8');
    socket.write(`* OK [CAPABILITY IMAP4rev1 UIDPLUS LITERAL+ ID] local bench IMAP\r\n`);
    const send = (line) => socket.write(`${line}\r\n`);
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (true) {
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const tokens = commandParts(line);
        if (!tokens.length) continue;
        const tag = tokens[0];
        const command = String(tokens[1] || '').toUpperCase();
        const rest = tokens.slice(2);
        const uidMode = command === 'UID';
        const sub = uidMode ? String(rest.shift() || '').toUpperCase() : command;
        try {
          if (command === 'CAPABILITY') {
            send('* CAPABILITY IMAP4rev1 UIDPLUS LITERAL+ ID'); send(`${tag} OK CAPABILITY completed`);
          } else if (command === 'LOGIN') {
            send(`${tag} OK LOGIN completed`);
          } else if (command === 'ID') {
            send('* ID NIL'); send(`${tag} OK ID completed`);
          } else if (command === 'LIST' || command === 'LSUB') {
            if (rest.includes('')) send('* LIST (\\Noselect) "/" ""');
            else send('* LIST (\\HasNoChildren) "/" "INBOX"');
            send(`${tag} OK LIST completed`);
          } else if (command === 'NAMESPACE') {
            send('* NAMESPACE (("" "/")) NIL NIL'); send(`${tag} OK NAMESPACE completed`);
          } else if (command === 'SELECT' || command === 'EXAMINE') {
            selected = true;
            send(`* ${messages.length} EXISTS`);
            send('* 0 RECENT');
            send('* OK [UIDVALIDITY 20261122] UIDs valid');
            send(`* OK [UIDNEXT ${nextUid}] Predicted next UID`);
            send('* FLAGS (\\Seen)');
            send('* OK [PERMANENTFLAGS (\\Seen)] Limited');
            send(`${tag} OK [${command === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] SELECT completed`);
          } else if (command === 'STATUS') {
            send(`* STATUS "INBOX" (MESSAGES ${messages.length} UIDNEXT ${nextUid})`); send(`${tag} OK STATUS completed`);
          } else if (command === 'ENABLE' || command === 'NOOP' || command === 'CHECK' || command === 'CLOSE' || command === 'UNSELECT') {
            send(`${tag} OK ${command} completed`);
          } else if (sub === 'SEARCH') {
            const sinceAt = parseSearchDate(rest.join(' '));
            const filtered = messages.filter((message) => !sinceAt || message.date >= sinceAt);
            send(`* SEARCH${filtered.length ? ` ${filtered.map((m) => m.uid).join(' ')}` : ''}`);
            send(`${tag} OK SEARCH completed`);
          } else if (sub === 'FETCH') {
            const range = rest.shift();
            const list = parseRange(range, messages, uidMode);
            const query = rest.join(' ');
            const sections = [...query.matchAll(/(?:BODY|BINARY)(?:\.PEEK)?\[([^\]]+)\](?:<[^>]*>)?/gi)].map((m) => m[1]);
            for (const message of list) {
              if (sections.length) {
                const fields = [];
                for (const section of sections) {
                  const part = findPart(message, section);
                  const isHeader = /^header$/i.test(section);
                  const payload = Buffer.from(isHeader ? `${message.rawHeaders}\n` : (part?.body || ''), 'utf8');
                  fields.push({ section, payload });
                }
                socket.write(`* ${message.seq} FETCH (UID ${message.uid} `);
                for (const field of fields) {
                  socket.write(`BODY[${field.section}] {${field.payload.length}}${CRLF}`);
                  socket.write(field.payload);
                  socket.write(' ');
                }
                socket.write(')');
                socket.write(CRLF);
              } else {
                send(`* ${message.seq} FETCH (UID ${message.uid} ENVELOPE ${envelope(message)} INTERNALDATE "${imapDate(message.date)}" BODYSTRUCTURE ${bodystructure(message)} RFC822.SIZE ${Buffer.byteLength(message.raw)})`);
              }
            }
            send(`${tag} OK FETCH completed`);
          } else if (command === 'LOGOUT') {
            send('* BYE Logging out'); send(`${tag} OK LOGOUT completed`); socket.end();
          } else {
            send(`${tag} OK ${command || sub} completed`);
          }
        } catch (error) {
          send(`${tag} NO ${String(error?.message || error).replace(/[\r\n]+/g, ' ')}`);
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => { imap.once('error', reject); imap.listen(0, '127.0.0.1', resolve); });
  return {
    smtpPort: smtp.address().port,
    imapPort: imap.address().port,
    messages,
    async close() {
      await Promise.all([new Promise((r) => smtp.close(r)), new Promise((r) => imap.close(r))]);
    }
  };
}

export const __test = { parseMime, parseAddress, bodystructure, envelope };
