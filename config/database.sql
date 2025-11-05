CREATE DATABASE IF NOT EXISTS whatsapp_sessions;
USE whatsapp_sessions;

CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(255) PRIMARY KEY,
    status VARCHAR(50),
    qr_code TEXT,
    auth_data TEXT,
    device_data TEXT,
    data TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);