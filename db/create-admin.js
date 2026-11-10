// db/create-admin.js
// Creates an admin user with a securely hashed password. Run after init-db:
//
//   npm run create-admin
//
// It prompts for a username and password in the terminal.

const bcrypt = require('bcryptjs');
const readline = require('readline');
const pool = require('./pool');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  console.log('=== SLICNA Admin User Setup ===');
  const username = (await ask('Enter a username (e.g. admin): ')).trim();
  const password = await ask('Enter a password (at least 8 characters): ');
  const role = (await ask('Enter a role [default: Administrator]: ')).trim() || 'Administrator';

  if (!username || password.length < 8) {
    console.error('\nA username and a password of at least 8 characters are required.');
    rl.close();
    await pool.end();
    process.exitCode = 1;
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role',
      [username, passwordHash, role]
    );
    console.log('\nAdmin user created successfully:');
    console.log(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      console.error('\nError: A user with that username already exists.');
    } else {
      console.error('\nError creating user:', err.message);
    }
    process.exitCode = 1;
  } finally {
    rl.close();
    await pool.end();
  }
}

main();
