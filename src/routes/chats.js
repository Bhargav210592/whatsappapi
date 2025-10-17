const express = require('express');
const router = express.Router();

module.exports = (sessions) => {
  // Get all chats
  router.get('/', async (req, res) => {
    const { session } = req.query;
    if (!session || !sessions[session] || !sessions[session].isConnected) {
      return res.status(400).json({ error: 'Not connected or invalid session' });
    }
    try {
      const chats = await sessions[session].sock.chats.all();
      res.json({ chats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  return router;
};
