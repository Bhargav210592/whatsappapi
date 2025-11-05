const express = require('express');
const bodyParser = require('body-parser');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');
const path = require('path');

const bot = require('../index');
const QRCode = require('qrcode');
const swagger = require('../swagger.json');
const db = require('../config/database');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// Serve swagger UI
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swagger));

// Sessions endpoints
app.get('/sessions', (req, res) => {
  const sessions = bot.listSessions();
  res.json({ sessions });
});

app.post('/sessions/add', async (req, res) => {
  const { session } = req.body || {};
  if (!session) return res.status(400).json({ error: 'Missing session parameter' });
  try {
    // Create a blank session record in DB (idempotent)
    await db.createSession(session);

    // Start the in-memory/socket session (this will generate QR and connection events)
    await bot.startSession(session);

    // Read the session row from DB to return authoritative session data
    const row = await db.getSession(session);
    const meta = bot.getSessionMeta(session);

    res.json({
      message: `Session ${session} created`,
      session: {
        id: session,
        status: row?.status || meta?.status || 'pending',
        hasQR: !!(meta?.lastQRCode || row?.qr_code),
        db: row || null
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/sessions/:sessionid', (req, res) => {
  const { sessionid } = req.params;
  const meta = bot.getSessionMeta(sessionid);
  if (!meta) return res.status(404).json({ error: 'Session not found' });
  res.json({ session: sessionid, status: meta.status, hasQR: !!meta.lastQRCode });
});

// sessions/status endpoint removed

app.post('/sessions/getqr', (req, res) => {
  const { session } = req.body || {};
  if (!session) return res.status(400).json({ error: 'Missing session parameter' });
  const meta = bot.getSessionMeta(session);
  if (!meta) return res.status(404).json({ error: 'Session not found' });
  if (!meta.lastQRCode) return res.status(404).json({ error: 'QR not available for this session' });
  // Return a URL where the QR image can be fetched as PNG. Swagger UI will render image/png responses.
  res.json({ qrUrl: `/sessions/${encodeURIComponent(session)}/qr` });
});

// Return QR as image/png so Swagger UI can render it directly in the response pane.
app.get('/sessions/:sessionid/qr', async (req, res) => {
  const { sessionid } = req.params;
  const meta = bot.getSessionMeta(sessionid);
  if (!meta) return res.status(404).json({ error: 'Session not found' });
  if (!meta.lastQRCode) return res.status(404).json({ error: 'QR not available for this session' });

  const qrString = meta.lastQRCode;
  try {
    // Generate PNG buffer from QR string
    const buffer = await QRCode.toBuffer(qrString, { margin: 1 });
    res.setHeader('Content-Type', 'image/png');
    res.send(buffer);
  } catch (e) {
    // If generation fails, return text fallback
    res.status(500).json({ error: 'Failed to generate QR image', detail: e.message || String(e) });
  }
});

function requireSock(res, session) {
  const sock = bot.getSock(session);
  if (!sock) {
    res.status(503).json({ error: `Session ${session} not initialized yet` });
    return null;
  }
  return sock;
}

app.post('/messages/sendtext', async (req, res) => {
  const { session, to, message } = req.body || {};
  if (!session || !to || !message) return res.status(400).json({ error: 'Missing required fields' });
  const sock = requireSock(res, session);
  if (!sock) return;
  try {
    const result = await sock.sendMessage(to, { text: message });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post('/messages/sendimage', async (req, res) => {
  const { session, to, image, caption } = req.body || {};
  if (!session || !to || !image) return res.status(400).json({ error: 'Missing required fields' });
  const sock = requireSock(res, session);
  if (!sock) return;
  try {
    let buffer;
    if (/^https?:\/\//.test(image)) {
      const fetch = require('node-fetch');
      const r = await fetch(image);
      buffer = await r.buffer();
    } else if (/^data:/.test(image)) {
      buffer = Buffer.from(image.split(',')[1], 'base64');
    } else {
      buffer = fs.readFileSync(path.resolve(image));
    }
    const result = await sock.sendMessage(to, { image: buffer, caption });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post('/messages/sendfile', async (req, res) => {
  const { session, to, file, mimetype, filename } = req.body || {};
  if (!session || !to || !file || !mimetype || !filename) return res.status(400).json({ error: 'Missing required fields' });
  const sock = requireSock(res, session);
  if (!sock) return;
  try {
    let buffer;
    if (/^https?:\/\//.test(file)) {
      const fetch = require('node-fetch');
      const r = await fetch(file);
      buffer = await r.buffer();
    } else if (/^data:/.test(file)) {
      buffer = Buffer.from(file.split(',')[1], 'base64');
    } else {
      buffer = fs.readFileSync(path.resolve(file));
    }
    const result = await sock.sendMessage(to, { document: buffer, fileName: filename, mimetype });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post('/chats', async (req, res) => {
  const { session } = req.body || {};
  if (!session) return res.status(400).json({ error: 'Missing session in request body' });
  const sock = requireSock(res, session);
  if (!sock) return;
  try {
    // If a store was attached, it will have a `chats` map. Convert to array.
    let chats = [];
    const meta = bot.getSessionMeta(session) || {};
    const store = (sock.store && sock.store.chats) ? sock.store : meta.store;
    if (store && store.chats) {
      const map = store.chats;
      if (typeof map.entries === 'function') {
        for (const [k, v] of map.entries()) chats.push(v);
      } else {
        for (const k of Object.keys(map)) chats.push(map[k]);
      }
    }

    // Normalize minimal chat fields for response
    const out = chats.map(c => ({ id: c.id || c.key?.remoteJid || c.chat?.id, name: c.name || c.contact?.name || c.subject || null, unread: c.unreadCount || c.unread || 0 }));
    res.json({ chats: out });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Force reset a session: delete auth info and restart
app.post('/sessions/:sessionid/reset', async (req, res) => {
  const { sessionid } = req.params;
  try {
    await bot.resetSession(sessionid);
    res.json({ ok: true, message: `Session ${sessionid} reset and restart attempted.` });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

const port = process.env.PORT || 3000;

(async () => {
  try {
    const restored = await bot.restoreSessions?.();
    if (restored && restored.length) console.log(`Restored sessions: ${restored.join(', ')}`);
  } catch (e) {
    console.warn('Error while restoring sessions:', e && e.message ? e.message : e);
  }
  app.listen(port, () => console.log(`API server listening on http://localhost:${port}`));
})();
