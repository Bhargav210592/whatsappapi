const pool = require('./db');

// Table: session_qr (session VARCHAR PRIMARY KEY, qr TEXT)

async function saveSessionQR(session, qr) {
  await pool.query('INSERT INTO session_qr (session, qr) VALUES (?, ?) ON DUPLICATE KEY UPDATE qr = VALUES(qr)', [session, qr]);
}

async function getSessionQR(session) {
  const [rows] = await pool.query('SELECT qr FROM session_qr WHERE session = ?', [session]);
  if (rows.length === 0) return null;
  return rows[0].qr;
}

module.exports = {
  saveSessionQR,
  getSessionQR
};
