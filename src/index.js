import 'dotenv/config';
import http from 'node:http';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';

const PORT = Number(process.env.PORT || 8080);
const GROUP_NAME = process.env.ATTENDANCE_GROUP_NAME || 'Problem Group';
const WEBHOOK = process.env.GOOGLE_APPS_SCRIPT_URL;
const TZ = process.env.TZ || 'Asia/Dhaka';

if (!WEBHOOK) {
  console.error('Missing GOOGLE_APPS_SCRIPT_URL environment variable.');
  process.exit(1);
}

let connected = false;

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      service: 'WhatsApp Attendance',
      whatsapp: connected ? 'connected' : 'starting'
    }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Health server listening on port ${PORT}`);
});

const logger = P({ level: process.env.LOG_LEVEL || 'info' });
let cachedGroup = null;
let reconnectTimer = null;

const normalizeText = (s = '') => s.replace(/\s+/g, ' ').trim();

function parseAttendance(text) {
  const t = normalizeText(text);
  const m = t.match(/^(.+?)\s+(entry(?:\s*time)?|left(?:\s*time)?)\s*[:\-]?\s*(\d{1,2})[.:](\d{2})\s*(am|pm)$/i);
  if (!m) return null;

  const name = m[1].trim().replace(/\s*[-:]\s*$/, '');
  const action = m[2].toLowerCase();
  const hour = Number(m[3]);
  const minute = Number(m[4]);
  const ampm = m[5].toUpperCase();

  if (hour < 1 || hour > 12 || minute > 59) return null;

  let h24 = hour % 12;
  if (ampm === 'PM') h24 += 12;

  return {
    name,
    type: action.startsWith('entry') ? 'ENTRY' : 'LEFT',
    time: `${String(h24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    displayTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${ampm}`,
    rawMessage: text
  };
}

async function postAttendance(event) {
  const response = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Google webhook ${response.status}: ${body.slice(0, 500)}`);
  logger.info({ response: body }, 'Attendance sent to Google Sheets');
}

async function findGroup(sock, force = false) {
  if (cachedGroup && !force) return cachedGroup;
  const groups = await sock.groupFetchAllParticipating();
  const found = Object.entries(groups).find(([, g]) =>
    normalizeText(g.subject).toLowerCase() === GROUP_NAME.toLowerCase()
  );
  if (!found) {
    cachedGroup = null;
    return null;
  }
  cachedGroup = { jid: found[0], subject: found[1].subject };
  return cachedGroup;
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;
  }

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n===== WHATSAPP QR =====\n');
      qrcode.generate(qr, { small: true });
      console.log('\nScan from WhatsApp → Linked devices.\n');
    }

    if (connection === 'open') {
      connected = true;
      const group = await findGroup(sock, true);
      if (group) logger.info(group, 'Target WhatsApp group found');
      else logger.warn({ GROUP_NAME }, 'Target WhatsApp group not found');
    }

    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, 'WhatsApp connection closed');

      if (shouldReconnect && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          startWhatsApp().catch(err => logger.error({ err }, 'WhatsApp restart failed'));
        }, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid?.endsWith('@g.us')) continue;

        const group = await findGroup(sock);
        if (!group || remoteJid !== group.jid) continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';

        const parsed = parseAttendance(text);
        if (!parsed) continue;

        await postAttendance({
          event: 'attendance',
          groupName: GROUP_NAME,
          groupJid: remoteJid,
          messageId: msg.key.id || '',
          senderJid: msg.key.participant || msg.key.remoteJid || '',
          receivedAt: new Date().toISOString(),
          timezone: TZ,
          ...parsed
        });
      } catch (err) {
        logger.error({ err }, 'Failed to process WhatsApp message');
      }
    }
  });
}

startWhatsApp().catch(err => {
  logger.error({ err }, 'WhatsApp startup failed');
  process.exit(1);
});
