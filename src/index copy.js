const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');

const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('../swagger.json');


const app = express();
app.use(express.json());
// Swagger docs endpoint
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));


const sessions = {};

async function startSock(session) {
    const authPath = `auth_info_baileys_${session}`;
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error = new Boom(lastDisconnect?.error))?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                startSock(session);
            }
            sessions[session] = { sock, isConnected: false };
        } else if (connection === 'open') {
            sessions[session] = { sock, isConnected: true };
        }
    });
    sessions[session] = { sock, isConnected: false };
}

// API Endpoints

app.post('/connect', async (req, res) => {
    const { session } = req.body;
    if (!session) return res.status(400).json({ error: 'Missing session parameter' });
    if (!sessions[session] || !sessions[session].isConnected) {
        await startSock(session);
        res.json({ status: 'Connecting, scan QR in terminal.', session });
    } else {
        res.json({ status: 'Already connected.', session });
    }
});


app.post('/send', async (req, res) => {
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


app.get('/chats', async (req, res) => {
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


app.get('/status', (req, res) => {
    const { session } = req.query;
    if (!session || !sessions[session]) {
        return res.status(400).json({ error: 'Invalid session' });
    }
    res.json({ connected: sessions[session].isConnected });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API server running on port ${PORT}`);
});
