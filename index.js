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
  let state, saveCreds;

  // Try to load from local auth files first
  if (fs.existsSync(authDir)) {
    logger.info(`Loading session ${sessionId} from local auth files`);
    ({ state, saveCreds } = await useMultiFileAuthState(authDir));
  } else {
    // If local auth not found, try to load from database
    try {
      const db = require('./config/database');
      const sessionData = await db.getSession(sessionId);
      
      if (sessionData && sessionData.status === 'connected' && sessionData.auth_data) {
        logger.info(`Restoring session ${sessionId} from database`);
        // Create auth directory
        fs.mkdirSync(authDir, { recursive: true });
        
        // Parse the stored auth data
        const authData = JSON.parse(sessionData.auth_data);
        
        // Write auth data to files
        await fs.promises.writeFile(
          path.join(authDir, 'creds.json'),
          JSON.stringify(authData, null, 2)
        );
        
        // Initialize state from written files
        ({ state, saveCreds } = await useMultiFileAuthState(authDir));
        logger.info(`Session ${sessionId} restored from database`);
      } else {
        // If not found in database either, create new session
        logger.info(`Creating new session ${sessionId}`);
        fs.mkdirSync(authDir, { recursive: true });
        // ensure DB record exists for this new session
        try {
          const db = require('./config/database');
          await db.createSession(sessionId);
        } catch (e) {
          logger.warn(`Failed to create DB record for session ${sessionId}: ${e && e.message ? e.message : e}`);
        }
        ({ state, saveCreds } = await useMultiFileAuthState(authDir));
      }
    } catch (err) {
      logger.error(`Failed to restore session ${sessionId} from database:`, err);
      // Fallback to new session
      fs.mkdirSync(authDir, { recursive: true });
      ({ state, saveCreds } = await useMultiFileAuthState(authDir));
    }
  }
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

  // Save creds updates -> persist creds.json content into auth_data
  sock.ev.on('creds.update', async (creds) => {
    await saveCreds();
    try {
      const db = require('./config/database');
      // ensure DB record exists
      await db.createSession(sessionId);
      // Only save auth_data on first occurrence. If auth_data already exists, skip further saves.
      const existingAuth = await db.getAuthState(sessionId);
      if (existingAuth) {
        logger.info(`auth_data already present for session ${sessionId}, skipping save`);
      } else {
        // Save only creds into auth_data (this matches creds.json)
        await db.saveAuthState(sessionId, creds);
        logger.info(`Session ${sessionId} credentials saved to auth_data in database`);
      }
    } catch (err) {
      logger.error(`Failed to save session ${sessionId} credentials in database:`, err && err.message ? err.message : err);
    }
  });

  // Listen for connection updates (QR, connected, disconnected)
  sock.ev.on('connection.update', async (update) => {
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
      
      // Save session state and creds to database
      try {
        const { state } = sess;
        const db = require('./config/database');
        await db.updateSessionConnection(sessionId, state.creds, {
          browser: sock.user?.browser || null,
          phone: sock.user?.id?.split(':')[0] || null
        });
        logger.info(`Session ${sessionId} state saved to database`);
      } catch (err) {
        logger.error(`Failed to save session ${sessionId} to database:`, err && err.message ? err.message : err);
      }
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

// Restore sessions from database (preferred) by writing creds.json into auth_info and starting sessions.
// Returns array of started session ids.
async function restoreSessions() {
  const base = path.resolve(process.cwd(), 'auth_info');
  const started = [];

  try {
    const db = require('./config/database');
    const dbSessions = await db.getAllSessions();

    for (const session of dbSessions) {
      const sessionId = session.id;
      try {
        const authDir = path.join(base, sessionId);
        // Ensure auth dir exists
        fs.mkdirSync(authDir, { recursive: true });

        // If we have auth_data, write creds.json from it (overwrite so DB is authoritative)
        if (session.auth_data) {
          let authObj = session.auth_data;
          try {
            if (typeof authObj === 'string') authObj = JSON.parse(authObj);
          } catch (parseErr) {
            logger.warn(`Failed to parse auth_data for session ${sessionId}: ${parseErr && parseErr.message ? parseErr.message : parseErr}`);
            authObj = null;
          }

          if (authObj) {
            // Write only the creds object if present, otherwise write authObj as-is
            const credsToWrite = authObj.creds ? authObj.creds : authObj;
            await fs.promises.writeFile(path.join(authDir, 'creds.json'), JSON.stringify(credsToWrite, null, 2));
            logger.info(`Wrote creds.json for session ${sessionId} from database auth_data`);
          }
        }

        // Start session (startSession will load from local files)
        await startSession(sessionId);
        started.push(sessionId);
      } catch (err) {
        logger.warn(`Failed to restore database session ${sessionId}: ${err && err.message ? err.message : err}`);
      }
    }
  } catch (err) {
    logger.warn('Error while restoring database sessions:', err && err.message ? err.message : err);
  }

  return started;
}

// export restoreSessions
module.exports.restoreSessions = restoreSessions;

