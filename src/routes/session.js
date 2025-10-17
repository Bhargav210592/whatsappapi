const express = require('express');
const router = express.Router();
const mysqlQR = require('../mysql-qr');

module.exports = (sessions, startSock) => {
  // Get list of all sessions
  router.get('/', (req, res) => {
    const allSessions = Object.entries(sessions).map(([session, data]) => ({
      session,
      connected: data.isConnected
    }));
    res.json({ sessions: allSessions });
  });




  // Create new session
  router.post('/add', async (req, res) => {
    const { session } = req.body;
    if (!session) return res.status(400).json({ error: 'Missing session parameter' });
    // Check if session exists in DB (by row, not just creds)
    const pool = require('../db');
    const [rows] = await pool.query('SELECT session FROM auth_sessions WHERE session = ?', [session]);
    if (rows.length > 0) {
      // Always initialize session
      startSock(session, async (qr) => {
        await mysqlQR.saveSessionQR(session, qr);
      });
      return res.json({ status: 'Session already exists', session });
    } else {
      // Insert empty creds to create session row
      const mysqlAuth = require('../mysql-auth');
      await mysqlAuth.saveAuthCreds(session, {});
      startSock(session, async (qr) => {
        await mysqlQR.saveSessionQR(session, qr);
      });
      return res.json({ status: 'Session created successfully', session });
    }
  });

  // Get QR for a session (POST)
  router.post('/getqr', async (req, res) => {
    const { session } = req.body;
    if (!session) return res.status(400).json({ error: 'Missing session parameter' });
    const dbQR = await mysqlQR.getSessionQR(session);
    if (dbQR) {
      res.json({ session, qr: dbQR });
    } else {
      res.status(404).json({ error: 'QR not available for this session' });
    }
  });

  // Get particular session
  router.get('/:sessionid', (req, res) => {
    const { sessionid } = req.params;
    if (!sessions[sessionid]) return res.status(404).json({ error: 'Session not found' });
    res.json({ session: sessionid, connected: sessions[sessionid].isConnected });
  });

  // Get status of all sessions
  router.get('/status', (req, res) => {
    const allSessions = Object.entries(sessions).map(([session, data]) => ({
      session,
      connected: data.isConnected
    }));
    res.json({ sessions: allSessions });
  });

  return router;
};
