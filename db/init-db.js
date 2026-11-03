// db/init-db.js
// Creates all tables by running db/schema.sql against the database in .env.
// Safe to re-run: every statement is CREATE ... IF NOT EXISTS.
//
//   npm run init-db

const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log(`Schema applied to database "${process.env.DB_NAME}".`);
  } catch (err) {
    console.error('Failed to apply schema:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
