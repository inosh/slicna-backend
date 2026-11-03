// middleware/rate-limit.js
// Rate limiter for the login endpoint, to slow down password guessing.

const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts from this device. Please try again in 15 minutes.' },
});

module.exports = { loginLimiter };
