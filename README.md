# WhatsApp Bot API

This project exposes a small HTTP API around the Baileys WhatsApp library. It supports creating sessions and sending messages via HTTP endpoints (see `swagger.json`).

Quick start

1. Install dependencies:

```powershell
cd 'd:\beta softech\bot-whatsapp'
npm install
```

2. Start the API server:

```powershell
npm run api
```

3. Create a session (this will create `auth_info/<session>` directory and start the socket):

POST /sessions/add
Body: { "session": "mysession1" }

4. Get QR (if available):

POST /sessions/getqr
Body: { "session": "mysession1" }

5. Send a message:

POST /messages/sendtext
Body: { "session": "mysession1", "to": "1234567890@s.whatsapp.net", "message": "Hello" }

Notes
- The API is unauthenticated. Protect it before exposing to the public.
- If Baileys reports the session is logged out, delete the `auth_info/<session>` directory and create the session again to re-authenticate.
