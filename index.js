// Load .env if present
try { require('dotenv').config(); } catch (e) {}

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeInMemoryStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const logger = pino({ level: process.env.LOG_LEVEL || 'info', transport: { target: 'pino-pretty' } });
// qrcode-terminal will render QR in terminal for quick checks
let qrcodeTerminal;
try {
  qrcodeTerminal = require('qrcode-terminal');
} catch (e) {
  // optional dependency — printing will be skipped if not installed
  qrcodeTerminal = null;
}

// Control whether to print QR in terminal via env var. Accepts 'true'/'false' (case-insensitive). Default: true
const PRINT_QR_CONSOLE = (process.env.PRINT_QR_CONSOLE || 'true').toLowerCase() === 'true';
logger.info(`PRINT_QR_CONSOLE=${PRINT_QR_CONSOLE}`);

// In-memory session store: sessionId -> { sock, state, lastQRCode, status }
const sessions = new Map();

async function startSession(sessionId) {
  if (!sessionId) throw new Error('sessionId required');
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    return existing.sock;
  }

  const authDir = path.resolve(process.cwd(), 'auth_info', sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Starting session ${sessionId} - Baileys v${version.join('.')}, Latest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsApp-API', 'Node.js', process.version],
  });

  // store minimal session metadata immediately so other handlers can access it
  const meta = { sock, state, lastQRCode: null, status: 'connecting', retryCount: 0, lastRestartAt: null };
  sessions.set(sessionId, meta);

  // attach an in-memory store so chats and contacts are available
  try {
    const store = makeInMemoryStore({});
    store.bind(sock.ev);
    meta.store = store;
  } catch (e) {
    logger.debug('Failed to attach in-memory store', e && e.message ? e.message : e);
  }

  // Save creds updates
  sock.ev.on('creds.update', saveCreds);

  // Listen for connection updates (QR, connected, disconnected)
  sock.ev.on('connection.update', (update) => {
    const sess = sessions.get(sessionId);
    if (!sess) return;
    // capture QR if provided
    if (update.qr) {
      // store raw qr string provided by Baileys
      sess.lastQRCode = update.qr;
      sess.status = 'qr';
      logger.info(`Session ${sessionId} has a QR`);
      // print raw QR to console for cross-check (configurable)
      if (PRINT_QR_CONSOLE) {
        try {
          console.log(`\n[QR][${sessionId}] raw:`, update.qr);
          if (qrcodeTerminal) {
            console.log(`[QR][${sessionId}] ASCII:`);
            qrcodeTerminal.generate(update.qr, { small: true });
          }
        } catch (e) {
          logger.warn('Failed to print QR to console', e && e.message ? e.message : e);
        }
      }
    }

    if (update.connection === 'open') {
      sess.status = 'connected';
      logger.info(`Session ${sessionId} connected`);
    }

    if (update.connection === 'close') {
      const statusCode = update.lastDisconnect && update.lastDisconnect.error && update.lastDisconnect.error.output && update.lastDisconnect.error.output.statusCode;
      sess.status = 'closed';
      logger.warn(`Session ${sessionId} disconnected: ${JSON.stringify(update.lastDisconnect || update)}`);

      // Auto-restart for stream errors (e.g., 515). Do not restart on logged-out (401) or similar.
      if (statusCode === 515) {
        const meta = sessions.get(sessionId) || {};
        const now = Date.now();
        const retries = meta.retryCount || 0;
        const maxRetries = 5;
        const retryDelay = Math.min(30000, 2000 * Math.pow(2, retries)); // backoff

        if (retries < maxRetries) {
          logger.warn(`Session ${sessionId} stream error ${statusCode} — scheduling restart in ${retryDelay}ms (attempt ${retries + 1}/${maxRetries})`);
          meta.retryCount = retries + 1;
          meta.lastRestartAt = now;
          // clear previous sock reference before restart
          try { if (meta.sock && meta.sock.ws && typeof meta.sock.ws.close === 'function') meta.sock.ws.close(); } catch (e) {}
          sessions.set(sessionId, meta);
          setTimeout(() => {
            // remove session entry and start a fresh one
            sessions.delete(sessionId);
            startSession(sessionId).then(() => logger.info(`Session ${sessionId} restarted (auto).`)).catch((err) => logger.error(`Auto-restart failed for ${sessionId}: ${err && err.message ? err.message : err}`));
          }, retryDelay);
        } else {
          logger.error(`Session ${sessionId} exceeded max restart attempts (${maxRetries}). Manual reset required.`);
        }
      }
    }
  });

  // simple messages.upsert handler - can be extended by loading events
  sock.ev.on('messages.upsert', async (msg) => {
    // No-op for now; applications can register handlers directly if needed
    logger.debug({ msg }, 'messages.upsert');
  });

  return sock;
}

function getSock(sessionId) {
  const sess = sessions.get(sessionId);
  return sess ? sess.sock : null;
}

function listSessions() {
  const out = [];
  for (const [id, meta] of sessions.entries()) {
    out.push({ session: id, status: meta.status || 'unknown', hasQR: !!meta.lastQRCode });
  }
  return out;
}

function getSessionMeta(sessionId) {
  return sessions.get(sessionId) || null;
}

async function resetSession(sessionId) {
  if (!sessionId) throw new Error('sessionId required');
  const authDir = path.resolve(process.cwd(), 'auth_info', sessionId);
  try {
    // close existing socket if present
    const meta = sessions.get(sessionId);
    if (meta && meta.sock && meta.sock.ws && typeof meta.sock.ws.close === 'function') {
      try { meta.sock.ws.close(); } catch (e) {}
    }
  } catch (e) {}

  // remove auth dir if it exists
  try {
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  } catch (e) {
    logger.warn(`Failed to remove auth dir for ${sessionId}: ${e && e.message ? e.message : e}`);
  }

  // delete in-memory meta and start a fresh session
  sessions.delete(sessionId);
  return startSession(sessionId);
}

module.exports = {
  startSession,
  getSock,
  listSessions,
  getSessionMeta,
  resetSession,
};

// Restore sessions found in auth_info directory. Returns array of started session ids.
async function restoreSessions() {
  const base = path.resolve(process.cwd(), 'auth_info');
  const started = [];
  try {
    if (!fs.existsSync(base)) return started;
    const entries = fs.readdirSync(base, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        const sessionId = e.name;
        try {
          await startSession(sessionId);
          started.push(sessionId);
        } catch (err) {
          logger.warn(`Failed to restore session ${sessionId}: ${err && err.message ? err.message : err}`);
        }
      }
    }
  } catch (err) {
    logger.warn('Error while restoring sessions:', err && err.message ? err.message : err);
  }
  return started;
}

// export restoreSessions
module.exports.restoreSessions = restoreSessions;
