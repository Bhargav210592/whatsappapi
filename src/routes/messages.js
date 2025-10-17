const express = require('express');
const router = express.Router();

module.exports = (sessions) => {
  // Send text message
  router.post('/sendtext', async (req, res) => {
    const { session, to, message } = req.body;
    if (!session || !sessions[session] || !sessions[session].isConnected) {
      return res.status(400).json({ error: 'Not connected or invalid session' });
    }
    try {
      const result = await sessions[session].sock.sendMessage(to, { text: message });
      res.json({ result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Send image (base64 or url)
  router.post('/sendimage', async (req, res) => {
    const { session, to, image, caption } = req.body;
    if (!session || !sessions[session] || !sessions[session].isConnected) {
      return res.status(400).json({ error: 'Not connected or invalid session' });
    }
    try {
      const result = await sessions[session].sock.sendMessage(to, { image: { url: image }, caption });
      res.json({ result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Send file (base64 or url)
  router.post('/sendfile', async (req, res) => {
    const { session, to, file, mimetype, filename } = req.body;
    if (!session || !sessions[session] || !sessions[session].isConnected) {
      return res.status(400).json({ error: 'Not connected or invalid session' });
    }
    try {
      const result = await sessions[session].sock.sendMessage(to, { document: { url: file }, mimetype, fileName: filename });
      res.json({ result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
