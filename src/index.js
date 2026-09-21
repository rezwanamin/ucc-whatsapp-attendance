import 'dotenv/config';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';

const GROUP_NAME = process.env.ATTENDANCE_GROUP_NAME || 'Problem Group';
const WEBHOOK = process.env.GOOGLE_APPS_SCRIPT_URL;
const TZ = process.env.TZ || 'Asia/Dhaka';

if (!WEBHOOK) {
  console.error('Missing GOOGLE_APPS_SCRIPT_URL in .env');
  process.exit(1);
}

const logger = P({ level: process.env.LOG_LEVEL || 'info' });

function normalizeText(s = '') {
  return s.replace(/\s+/g, ' ').trim();
}

function parseAttendance(text) {
  const t = normalizeText(text);

  // Examples:
  // Ratna Entry Time 10.12am
  // Ratna Entry 10:12 AM
  // Ratna Left time 6.30pm
  // Ratna left 6:30 PM
  const m = t.match(/^(.+?)\s+(entry(?:\s*time)?|left(?:\s*time)?)\s*[:\-]?\s*(\d{1,2})[.:](\d{2})\s*(am|pm)$/i);
  if (!m) return null;

  const name = m[1].trim().replace(/\s*[-:]\s*$/, '');
  const actionWord = m[2].toLowerCase();
  const hour = Number(m[3]);
  const minute = Number(m[4]);
  const ampm = m[5].toUpperCase();

  if (hour < 1 || hour > 12 || minute > 59) return null;

  let h24 = hour % 12;
  if (ampm === 'PM') h24 += 12;

  return {
    name,
    type: actionWord.startsWith('entry') ? 'ENTRY' : 'LEFT',
    time: `${String(h24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    displayTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${ampm}`,
    rawMessage: text
  };
}

async function postAttendance(event) {
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`Webhook ${res.status}: ${body.slice(0, 300)}`);
  logger.info({ body }, 'Attendance sent to Google Sheet');
}

async function findGroup(sock) {
  const groups = await sock.groupFetchAllParticipating();
  const found = Object.entries(groups).find(([, g]) =>
    normalizeText(g.subject).toLowerCase() === GROUP_NAME.toLowerCase()
  );
  return found ? { jid: found[0], subject: found[1].subject } : null;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1015901307];
  }

  const sock = makeWASocket({
    version,
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
      console.log('\nScan this QR from WhatsApp > Linked devices:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('WhatsApp connected');
      const group = await findGroup(sock);
      if (!group) {
        logger.error({ GROUP_NAME }, 'Target group not found');
      } else {
        logger.info(group, 'Target group found');
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, 'WhatsApp connection closed');

      if (shouldReconnect) {
        setTimeout(start, 5000);
      } else {
        logger.error('Logged out. Delete auth_info and run again to pair.');
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
        if (!parsed) return;

        await postAttendance({
          event: 'attendance',
          groupName: GROUP_NAME,
          groupJid: remoteJid,
          messageId: msg.key.id,
          senderJid: msg.key.participant || msg.key.remoteJid,
          receivedAt: new Date().toISOString(),
          timezone: TZ,
          ...parsed
        });
      } catch (err) {
        logger.error({ err }, 'Failed to process message');
      }
    }
  });
}

start().catch(err => {
  logger.error(err);
  process.exit(1);
});
