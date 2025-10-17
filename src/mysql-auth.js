const pool = require('./db');

// Table: auth_sessions (session VARCHAR PRIMARY KEY, creds JSON, keys JSON)

async function getAuthCreds(session) {
  const [rows] = await pool.query('SELECT creds FROM auth_sessions WHERE session = ?', [session]);
  if (rows.length === 0) return null;
  const val = rows[0].creds;
  if (!val || typeof val !== 'string' || val === 'null' || val === '') return null;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

async function saveAuthCreds(session, creds) {
  const credsStr = JSON.stringify(creds);
  await pool.query('INSERT INTO auth_sessions (session, creds) VALUES (?, ?) ON DUPLICATE KEY UPDATE creds = VALUES(creds)', [session, credsStr]);
}

async function getAuthKeys(session) {
  const [rows] = await pool.query('SELECT `keys` FROM auth_sessions WHERE session = ?', [session]);
  if (rows.length === 0) return null;
  const val = rows[0].keys;
  if (!val || typeof val !== 'string' || val === 'null' || val === '') return null;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

async function saveAuthKeys(session, keys) {
  const keysStr = JSON.stringify(keys);
  await pool.query('INSERT INTO auth_sessions (session, `keys`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `keys` = VALUES(`keys`)', [session, keysStr]);
}

async function getAllSessions() {
  const [rows] = await pool.query('SELECT session FROM auth_sessions');
  return rows.map(r => r.session);
}

module.exports = {
  getAuthCreds,
  saveAuthCreds,
  getAuthKeys,
  saveAuthKeys,
  getAllSessions
};
