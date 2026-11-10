// db/pool.js
// Shared PostgreSQL connection pool for the whole app.
// Reads connection details from environment variables (.env file).

const { Pool, types } = require('pg');
require('dotenv').config();

// Return SQL "date" columns as plain "YYYY-MM-DD" strings instead of JS Dates,
// which would shift by a day when serialised from Sri Lanka time (UTC+5:30).
types.setTypeParser(1082, (value) => value);
// Return numeric columns (e.g. cpd_points) as numbers rather than strings.
types.setTypeParser(1700, (value) => (value === null ? null : parseFloat(value)));

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'slicna_db',
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

module.exports = pool;
