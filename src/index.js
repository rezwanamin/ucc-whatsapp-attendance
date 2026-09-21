import 'dotenv/config';
import http from 'node:http';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import P from 'pino';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';

const PORT = Number(process.env.PORT || 8080);
const GROUP_NAME = process.env.ATTENDANCE_GROUP_NAME || 'Problem Group';
const WEBHOOK = process.env.GOOGLE_APPS_SCRIPT_URL;
const TZ = process.env.TZ || 'Asia/Dhaka';
const QR_TOKEN = process.env.QR_TOKEN;

if (!WEBHOOK) {
  console.error('ERROR: Missing GOOGLE_APPS_SCRIPT_URL environment variable.');
  process.exit(1);
}

if (!QR_TOKEN) {
  console.error('ERROR: Missing QR_TOKEN environment variable.');
  process.exit(1);
}

const logger = P({ level: process.env.LOG_LEVEL || 'info' });

let connected = false;
let currentQr = null;
let qrUpdatedAt = null;
let cachedGroup = null;
let groupFound = false;
let reconnectTimer = null;
let startedAt = new Date().toISOString();

const normalizeText = (s = '') => s.replace(/\s+/g, ' ').trim();

function safeEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length && a === b;
}

function authorized(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token') || req.headers['x-qr-token'];
  return safeEqual(token, QR_TOKEN);
}


const recentMessages = [];
const MAX_RECENT_MESSAGES = 50;

function rememberMessage(item) {
  recentMessages.unshift({
    ...item,
    at: new Date().toISOString()
  });
  if (recentMessages.length > MAX_RECENT_MESSAGES) {
    recentMessages.length = MAX_RECENT_MESSAGES;
  }
}

function extractMessageText(message) {
  if (!message) return '';

  const direct =
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption;

  if (direct) return direct;

  // Common WhatsApp wrapper messages.
  const wrappers = [
    message.ephemeralMessage?.message,
    message.viewOnceMessage?.message,
    message.viewOnceMessageV2?.message,
    message.viewOnceMessageV2Extension?.message,
    message.documentWithCaptionMessage?.message,
    message.editedMessage?.message
  ];

  for (const inner of wrappers) {
    const text = extractMessageText(inner);
    if (text) return text;
  }

  return '';
}

function parseAttendance(text) {
  // Remove harmless trailing punctuation often added in WhatsApp messages.
  const t = normalizeText(text).replace(/[.!?。]+$/u, '').trim();

  // Accepted examples:
  // Maidul Entry Time 6.00am
  // Maidul Entry 6:00 AM
  // Maidul Left time 6.00pm.
  // Maidul LEFT 6:00 PM!
  const m = t.match(
    /^(.+?)\s+(entry(?:\s*time)?|left(?:\s*time)?)\s*[:\-]?\s*(\d{1,2})[.:](\d{2})\s*(am|pm)$/i
  );

  if (!m) return null;

  const name = m[1].trim().replace(/\s*[-:]\s*$/, '');
  const action = m[2].toLowerCase();
  const hour = Number(m[3]);
  const minute = Number(m[4]);
  const ampm = m[5].toUpperCase();

  if (!name || hour < 1 || hour > 12 || minute > 59) return null;

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

  if (!response.ok) {
    throw new Error(`Google webhook ${response.status}: ${body.slice(0, 500)}`);
  }

  logger.info({ response: body }, 'Attendance sent to Google Sheets');
}


async function sendTestAttendance() {
  const now = new Date();
  const testEvent = {
    event: 'attendance',
    groupName: GROUP_NAME,
    groupJid: 'TEST-GROUP',
    messageId: `TEST-${Date.now()}`,
    senderJid: 'TEST-SENDER',
    receivedAt: now.toISOString(),
    timezone: TZ,
    name: 'TEST USER',
    type: 'ENTRY',
    time: '10:12',
    displayTime: '10:12 AM',
    rawMessage: 'TEST USER Entry Time 10.12am'
  };

  await postAttendance(testEvent);
  return testEvent;
}

async function findGroup(sock, force = false) {
  if (cachedGroup && !force) return cachedGroup;

  logger.info({ GROUP_NAME }, 'Searching WhatsApp groups...');

  const groups = await sock.groupFetchAllParticipating();

  const found = Object.entries(groups).find(([, g]) =>
    normalizeText(g.subject).toLowerCase() === GROUP_NAME.toLowerCase()
  );

  if (!found) {
    cachedGroup = null;
    groupFound = false;
    logger.warn({ GROUP_NAME }, 'Target WhatsApp group not found');
    return null;
  }

  cachedGroup = {
    jid: found[0],
    subject: found[1].subject
  };

  groupFound = true;
  logger.info(cachedGroup, 'Target WhatsApp group found');

  return cachedGroup;
}

function htmlPage(title, body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{font-family:Arial,sans-serif;background:#f5f7fa;margin:0;padding:30px;text-align:center}
.card{max-width:520px;margin:auto;background:#fff;border-radius:16px;padding:25px;box-shadow:0 5px 25px rgba(0,0,0,.08)}
h1{font-size:24px;margin-top:0}
img{max-width:100%;height:auto;border:10px solid #fff}
.muted{color:#666}
.ok{color:#16803c;font-weight:700}
.warn{color:#b36b00;font-weight:700}
.err{color:#c62828;font-weight:700}
code{background:#f0f0f0;padding:3px 6px;border-radius:5px}
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    res.setHeader('Cache-Control', 'no-store');

    if (url.pathname === '/' || url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        service: 'WhatsApp Attendance',
        version: '1.6.0',
        whatsapp: connected ? 'connected' : 'starting',
        groupFound
      }));
      return;
    }

    if (url.pathname === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        version: '1.6.0',
        whatsapp: connected ? 'connected' : 'not_connected',
        groupName: GROUP_NAME,
        groupFound,
        qrAvailable: Boolean(currentQr),
        qrUpdatedAt,
        startedAt
      }));
      return;
    }



    if (url.pathname === '/messages') {
      if (!authorized(req)) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(401);
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        count: recentMessages.length,
        messages: recentMessages
      }));
      return;
    }

    if (url.pathname === '/messages/clear') {
      if (!authorized(req)) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(401);
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      recentMessages.length = 0;
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: 'Diagnostic messages cleared' }));
      return;
    }

    if (url.pathname === '/test-google') {
      if (!authorized(req)) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(401);
        res.end(JSON.stringify({
          ok: false,
          error: 'Unauthorized. Add ?token=YOUR_QR_TOKEN'
        }));
        return;
      }

      const testEvent = await sendTestAttendance();

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        message: 'Test attendance sent to Google Apps Script',
        event: testEvent
      }));
      return;
    }

    if (url.pathname === '/debug') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        whatsapp: connected ? 'connected' : 'not_connected',
        groupName: GROUP_NAME,
        groupFound,
        qrAvailable: Boolean(currentQr),
        webhookConfigured: Boolean(WEBHOOK),
        qrTokenConfigured: Boolean(QR_TOKEN),
        uptimeSeconds: Math.floor(process.uptime())
      }));
      return;
    }

    if (url.pathname === '/qr') {
      if (!authorized(req)) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(401);
        res.end(JSON.stringify({
          ok: false,
          error: 'Unauthorized. Add ?token=YOUR_QR_TOKEN'
        }));
        return;
      }

      if (connected) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(htmlPage('WhatsApp Connected', `
          <h1>✅ WhatsApp Connected</h1>
          <p class="ok">The WhatsApp account is already linked.</p>
          <p>Group: <code>${GROUP_NAME}</code></p>
          <p class="muted">You can close this page.</p>
        `));
        return;
      }

      if (!currentQr) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(htmlPage('WhatsApp QR', `
          <h1>⏳ QR Not Ready</h1>
          <p class="muted">WhatsApp is starting. Refresh this page after a few seconds.</p>
          <script>setTimeout(()=>location.reload(),5000)</script>
        `));
        return;
      }

      const dataUrl = await QRCode.toDataURL(currentQr, {
        width: 420,
        margin: 2,
        errorCorrectionLevel: 'M'
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(htmlPage('Scan WhatsApp QR', `
        <h1>📱 Scan this QR</h1>
        <p>WhatsApp → <b>Linked devices</b> → <b>Link a device</b></p>
        <img src="${dataUrl}" alt="WhatsApp QR Code">
        <p class="muted">This page refreshes every 10 seconds.</p>
        <script>setTimeout(()=>location.reload(),10000)</script>
      `));
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  } catch (err) {
    logger.error({ err }, 'HTTP request failed');
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info({ PORT }, 'Health/QR server listening');
});

async function startWhatsApp() {
  logger.info('Starting WhatsApp initialization...');

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  logger.info('Auth state initialized');

  let version;
  try {
    logger.info('Fetching latest Baileys WhatsApp version...');
    ({ version } = await fetchLatestBaileysVersion());
    logger.info({ version }, 'Baileys version loaded');
  } catch (err) {
    logger.warn({ err }, 'Could not fetch latest Baileys version; using library default');
    version = undefined;
  }

  logger.info('Creating WhatsApp socket...');

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

  logger.info('WhatsApp socket created');

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQr = qr;
      qrUpdatedAt = new Date().toISOString();

      console.log('\n===== WHATSAPP QR (terminal fallback) =====\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\nOpen /qr?token=YOUR_QR_TOKEN in your browser to scan.\n');

      logger.info('New WhatsApp QR generated');
    }

    if (connection === 'open') {
      connected = true;
      currentQr = null;
      qrUpdatedAt = null;

      logger.info('WhatsApp connection OPEN');

      try {
        await findGroup(sock, true);
      } catch (err) {
        groupFound = false;
        logger.error({ err }, 'Could not search WhatsApp groups');
      }
    }

    if (connection === 'close') {
      connected = false;
      groupFound = false;

      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      logger.warn({ code, shouldReconnect }, 'WhatsApp connection closed');

      if (shouldReconnect && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          startWhatsApp().catch(err =>
            logger.error({ err }, 'WhatsApp restart failed')
          );
        }, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    logger.info({
      event: 'messages.upsert',
      upsertType: type || '',
      count: Array.isArray(messages) ? messages.length : 0
    }, 'WhatsApp messages.upsert received');

    for (const msg of messages || []) {
      try {
        if (!msg?.key) continue;

        const remoteJid = msg.key.remoteJid || '';
        const participant = msg.key.participant || '';
        const fromMe = Boolean(msg.key.fromMe);
        const text = extractMessageText(msg.message);

        const isGroup = remoteJid.endsWith('@g.us');
        const groupMatched = Boolean(
          isGroup &&
          cachedGroup &&
          remoteJid === cachedGroup.jid
        );

        const parsed = text ? parseAttendance(text) : null;

        if (isGroup) {
          rememberMessage({
            upsertType: type || '',
            messageId: msg.key.id || '',
            remoteJid,
            participant,
            fromMe,
            groupName: GROUP_NAME,
            groupMatched,
            text,
            parsed
          });
        }

        // Only the configured group is processed.
        if (!isGroup || !groupMatched || !msg.message) continue;

        // Sender identity is intentionally NOT used as a filter.
        if (!text) continue;
        if (!parsed) continue;

        logger.info({
          group: GROUP_NAME,
          fromMe,
          participant,
          text,
          parsed
        }, 'Attendance message matched; sending to Google');

        try {
          await postAttendance({
            event: 'attendance',
            groupName: GROUP_NAME,
            groupJid: remoteJid,
            messageId: msg.key.id || '',
            senderJid: participant || remoteJid,
            receivedAt: new Date().toISOString(),
            timezone: TZ,
            ...parsed
          });

          rememberMessage({
            upsertType: type || '',
            messageId: msg.key.id || '',
            remoteJid,
            participant,
            fromMe,
            groupName: GROUP_NAME,
            groupMatched: true,
            text,
            parsed,
            googlePost: 'success'
          });
        } catch (err) {
          rememberMessage({
            upsertType: type || '',
            messageId: msg.key.id || '',
            remoteJid,
            participant,
            fromMe,
            groupName: GROUP_NAME,
            groupMatched: true,
            text,
            parsed,
            googlePost: 'failed',
            googleError: String(err?.message || err)
          });
          throw err;
        }
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
