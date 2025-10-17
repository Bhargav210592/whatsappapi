require('dotenv').config();
const express = require('express');
const fs = require('fs');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const mysqlAuth = require('./mysql-auth');
const mysqlQR = require('./mysql-qr');

const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('../swagger.json');


const app = express();
app.use(express.json());
// Swagger docs endpoint
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));


const sessions = {};
// Reconnect to all previous sessions on server start (MySQL)
async function reconnectAllSessions() {
    const sessionsList = await mysqlAuth.getAllSessions();
    for (const session of sessionsList) {
        startSock(session);
    }
}


// MySQL-based Baileys auth state
function useMySQLAuthState(session) {
    return {
        state: {
            async creds() {
                const creds = await mysqlAuth.getAuthCreds(session);
                return creds && Object.keys(creds).length > 0 ? creds : initAuthCreds();
            },
            async keys() {
                const keys = await mysqlAuth.getAuthKeys(session);
                return keys && Object.keys(keys).length > 0 ? keys : {};
            }
        },
        async saveCreds(creds) {
            await mysqlAuth.saveAuthCreds(session, creds);
        },
        async saveKeys(keys) {
            await mysqlAuth.saveAuthKeys(session, keys);
        }
    };
}

async function startSock(session) {
    const { state, saveCreds, saveKeys } = useMySQLAuthState(session);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: {
            creds: await state.creds(),
            keys: await state.keys(),
        },
        printQRInTerminal: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: true
    });

    // Batch event processing
    sock.ev.process(async (events) => {
        if (events['connection.update']) {
            const update = events['connection.update'];
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                // qrcode.generate(qr, { small: true });
                // Save QR to database as base64
                const qrBase64 = await new Promise((resolve, reject) => {
                    require('qrcode').toDataURL(qr, (err, url) => {
                        if (err) reject(err);
                        else resolve(url);
                    });
                });
                await mysqlQR.saveSessionQR(session, qrBase64);
            }
            if (connection === 'close') {
                if ((lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : undefined) !== DisconnectReason.loggedOut) {
                    startSock(session);
                }
                sessions[session] = { sock, isConnected: false };
            } else if (connection === 'open') {
                sessions[session] = { sock, isConnected: true };
            }
        }
        if (events['creds.update']) {
            await saveCreds(events['creds.update']);
        }
        if (events['keys.update']) {
            await saveKeys(events['keys.update']);
        }
        // You can add more event handlers here as needed
    });
    sessions[session] = { sock, isConnected: false };
    return sock;
}


// Routers
const sessionRouter = require('./routes/session')(sessions, startSock);
const messagesRouter = require('./routes/messages')(sessions);
const chatsRouter = require('./routes/chats')(sessions);

app.use('/sessions', sessionRouter);
app.use('/messages', messagesRouter);
app.use('/chats', chatsRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await reconnectAllSessions();
});
