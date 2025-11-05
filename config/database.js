require('dotenv').config();
const mysql = require('mysql2/promise');

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'whatsapp_sessions',
    port: parseInt(process.env.DB_PORT || '3306', 10)
};

const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Database utility functions
const db = {
    pool,
    
    // Create new session
    async createSession(sessionId) {
        // Insert a blank record with explicit NULLs for JSON/text columns to avoid strict-mode errors
        const [result] = await pool.query(
            'INSERT INTO sessions (id, status, qr_code, data, auth_data, device_data) VALUES (?, ?, NULL, NULL, NULL, NULL) ON DUPLICATE KEY UPDATE status = ?',
            [sessionId, 'pending', 'pending']
        );
        return result;
    },

    // Update session QR code
    async updateSessionQR(sessionId, qrCode) {
        const [result] = await pool.query(
            'UPDATE sessions SET qr_code = ?, status = ? WHERE id = ?',
            [qrCode, 'qr_generated', sessionId]
        );
        return result;
    },

    // Update session connection status and data
    async updateSessionConnection(sessionId, authData, deviceData) {
        try {
            // First ensure the session exists
            await this.createSession(sessionId);
            
            // Then update it
            const [result] = await pool.query(
                'UPDATE sessions SET status = ?, auth_data = ?, device_data = ?, qr_code = NULL WHERE id = ?',
                ['connected', JSON.stringify(authData), JSON.stringify(deviceData), sessionId]
            );
            return result;
        } catch (error) {
            console.error('Database error in updateSessionConnection:', error.message);
            throw error;
        }
    },

    // Get all active sessions from database
    async getAllSessions() {
        const [rows] = await pool.query(
            'SELECT id, status, auth_data, device_data FROM sessions WHERE status = ?',
            ['connected']
        );
        return rows;
    },

    // Get specific session data
    async getSession(sessionId) {
        const [rows] = await pool.query(
            'SELECT id, status, auth_data, device_data FROM sessions WHERE id = ?',
            [sessionId]
        );
        return rows[0];
    },

    // Get session data
    async getSession(sessionId) {
        const [rows] = await pool.query('SELECT * FROM sessions WHERE id = ?', [sessionId]);
        return rows[0];
    },

    // List all sessions
    async listSessions() {
        const [rows] = await pool.query('SELECT id, status, created_at, updated_at FROM sessions');
        return rows;
    },

    // Update session status
    async updateSessionStatus(sessionId, status) {
        const [result] = await pool.query(
            'UPDATE sessions SET status = ? WHERE id = ?',
            [status, sessionId]
        );
        return result;
    },

    // Save auth state
    async saveAuthState(sessionId, authState) {
        if (authState == null) {
            const [result] = await pool.query(
                'UPDATE sessions SET auth_data = NULL WHERE id = ?',
                [sessionId]
            );
            return result;
        }
        const [result] = await pool.query(
            'UPDATE sessions SET auth_data = ? WHERE id = ?',
            [JSON.stringify(authState), sessionId]
        );
        return result;
    },

    // Get auth state
    async getAuthState(sessionId) {
        const [rows] = await pool.query(
            'SELECT auth_data FROM sessions WHERE id = ?',
            [sessionId]
        );
        return rows[0]?.auth_data ? JSON.parse(rows[0].auth_data) : null;
    }
};

// Wrap the pool query to add logging
const originalQuery = pool.query.bind(pool);
pool.query = async function wrappedQuery(...args) {
    try {
        console.log('Executing SQL:', args[0]);
        if (args[1]) console.log('With parameters:', args[1]);
        const result = await originalQuery(...args);
        console.log('Query successful');
        return result;
    } catch (error) {
        console.error('Query failed:', error.message);
        throw error;
    }
};

// Test the connection
pool.getConnection()
    .then(connection => {
        console.log('Database connected successfully');
        // Test table existence
        return connection.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id VARCHAR(255) PRIMARY KEY,
                status VARCHAR(50),
                qr_code TEXT,
                data JSON,
                auth_data JSON,
                device_data JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `).then(() => {
            console.log('Sessions table verified/created');
            // Schema alterations will be handled manually by the user when needed.
            connection.release();
        });
    })
    .catch(err => {
        console.error('Database Error:', err);
        console.error('Full error details:', {
            code: err.code,
            errno: err.errno,
            sql: err.sql,
            sqlState: err.sqlState,
            sqlMessage: err.sqlMessage
        });
    });

module.exports = db;