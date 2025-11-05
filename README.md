# WhatsApp Bot API

This project exposes a small HTTP API around the Baileys WhatsApp library. It supports creating sessions and sending messages via HTTP endpoints (see `swagger.json`).

Important: session/auth state is stored in your configured MySQL database (not in local files). The repository previously used `auth_info/<session>` folders; that has been replaced with DB-backed storage.

Quick start

1. Install dependencies:

```powershell
cd "d:\WORKSPACE\WHATSAPPAPI\bot-whatsapp"
npm install
```

2. Configure environment variables

Copy `.env.example` to `.env` and update the DB and API settings (DB host, user, password, name, port, API port, etc.).

3. Create the database and schema

Run the SQL in `config/database.sql` against your MySQL server. This will create the `sessions` table. If you want to store auth/device JSON columns, run the migrations below (see "Schema additions").

Example (PowerShell):

```powershell
# run the base schema
mysql -h <host> -P <port> -u <user> -p<password> < config\database.sql

# optionally add auth/device columns if not present
mysql -h <host> -P <port> -u <user> -p<password> -e "ALTER TABLE wapi.sessions ADD COLUMN IF NOT EXISTS auth_data JSON, ADD COLUMN IF NOT EXISTS device_data JSON;"
```

If your MySQL version doesn't support `ADD COLUMN IF NOT EXISTS`, run separate ALTER statements and ignore "duplicate column" errors, or ask me to generate a migration script for your server.

4. Start the API server:

```powershell
npm run api
```

Core endpoints

- POST /sessions/add
	- Body: { "session": "mysession1" }
	- Creates a blank session record in the DB (status = 'pending') and starts the WhatsApp connection. The server will save QR and auth data into the DB as events occur.

- GET /sessions
	- List sessions (reads from DB)

- GET /sessions/:sessionid
	- Returns session metadata from DB (status, QR presence, timestamps, device info)

- GET /sessions/:sessionid/qr
	- Returns the latest QR code image (if available) stored in DB

- DELETE /sessions/:sessionid
	- Stops the socket (if running), clears auth data in DB and marks session as deleted

Sending messages

- POST /messages/sendtext
	- Body: { "session": "mysession1", "to": "1234567890@s.whatsapp.net", "message": "Hello" }

Notes and operational details
- Session/auth state is stored in the `sessions` table. The code writes `auth_data` (JSON) when credentials update and `device_data` when the device connects.
- The app no longer creates or reads `auth_info/<session>` local folders. If you previously had those folders, they are unused after this update. You may remove them.
- If a session is logged out or you want to re-authenticate, use `DELETE /sessions/:sessionid` (it will clear `auth_data` and set the status to `pending`) and then call `POST /sessions/add` to re-create and re-authenticate.

Schema additions (manual step)

If you want the DB to store auth and device JSON, add these columns to your `sessions` table:

```sql
ALTER TABLE sessions
	ADD COLUMN auth_data JSON,
	ADD COLUMN device_data JSON;
```

If your MySQL version doesn't support `JSON` columns, you can use `TEXT` instead.

Security

- The API is unauthenticated by default. Set `API_KEY` in `.env` to enable simple API key protection (the server will require `X-API-Key` header).
- Configure `CORS_ORIGIN` in `.env` to restrict origins.

Troubleshooting

- If sessions are not appearing in the DB after calling `POST /sessions/add`, check the API logs for SQL errors and confirm your `.env` DB settings are correct.
- Use the `config/database.sql` to create the base table, then add columns manually as needed.

Want help migrating or generating a migration script? Tell me your MySQL version and I will provide a compatible ALTER script or create a migration file you can run.
