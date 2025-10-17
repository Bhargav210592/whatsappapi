CREATE TABLE IF NOT EXISTS auth_sessions (
  session VARCHAR(255) PRIMARY KEY,
  creds JSON,
  `keys` JSON
);
