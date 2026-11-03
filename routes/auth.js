// routes/auth.js
// Staff login. Verifies username/password against the users table
// (bcrypt-hashed) and issues an 8-hour JWT on success.

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { loginLimiter } = require('../middleware/rate-limit');
const { requireAuth } = require('../middleware/auth');
require('dotenv').config();

const router = express.Router();

// Per-username lockout on top of the per-IP rate limiter, so guesses spread
// across many devices still lock the account for 15 minutes.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const failedAttemptsByUsername = new Map();

function isLockedOut(username) {
  const entry = failedAttemptsByUsername.get(username);
  if (!entry || !entry.lockedUntil) return false;
  if (entry.lockedUntil <= Date.now()) {
    failedAttemptsByUsername.delete(username);
    return false;
  }
  return true;
}

function recordFailedAttempt(username) {
  const entry = failedAttemptsByUsername.get(username) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_FAILED_ATTEMPTS) entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  failedAttemptsByUsername.set(username, entry);
}

router.post('/login', loginLimiter, async (req, res, next) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (isLockedOut(username)) {
    return res.status(429).json({ error: 'Too many failed login attempts for this account. Please try again in 15 minutes.' });
  }

  try {
    const user = (await pool.query('SELECT * FROM users WHERE username = $1', [username])).rows[0];
    const passwordMatches = user && (await bcrypt.compare(password, user.password_hash));
    if (!passwordMatches) {
      recordFailedAttempt(username);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    failedAttemptsByUsername.delete(username);
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    next(err);
  }
});

// Lets a logged-in staff user change their own password (needs the current one).
router.post('/change-password', requireAuth, loginLimiter, async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  try {
    const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(newPassword, 10), user.id]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
