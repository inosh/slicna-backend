// server.js
// Main entry point for the SLICNA backend API.
// Run with: npm start   (or: npm run dev  for auto-restart on changes)

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const newsRoutes = require('./routes/news');
const journalsRoutes = require('./routes/journals');
const eventsRoutes = require('./routes/events');
const eventsAdminRoutes = require('./routes/events-admin');
const milestonesRoutes = require('./routes/milestones');
const committeeRoutes = require('./routes/committee');
const settingsRoutes = require('./routes/settings');
const communityRoutes = require('./routes/community');
const albumsRoutes = require('./routes/albums');
const membershipRoutes = require('./routes/membership');
const membershipAdminRoutes = require('./routes/membership-admin');

const app = express();
const PORT = process.env.PORT || 3001;

// crossOriginResourcePolicy is relaxed so the frontend (a different origin)
// can load images from /uploads.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Only the configured frontend origin(s) -- plus localhost for development --
// may call this API from a browser.
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true); // curl, server-to-server
    const normalized = origin.replace(/\/+$/, '');
    if (allowedOrigins.includes(normalized) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  // Lets the admin panel save private downloads under the server's file name.
  exposedHeaders: ['Content-Disposition'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Uploaded images live on local disk for now (to be moved to Cloudflare R2).
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d', fallthrough: false }));

// --- Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/journals', journalsRoutes);
app.use('/api/events/admin', eventsAdminRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/milestones', milestonesRoutes);
app.use('/api/committee', committeeRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/albums', albumsRoutes);
// Admin routes first: /api/membership/admin/* all require a login.
app.use('/api/membership/admin', membershipAdminRoutes);
app.use('/api/membership', membershipRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'SLICNA backend is running.' });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

// Readable messages for upload problems (file too large, wrong type, ...).
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'That file is too large. Photos must be under 15MB, journal PDFs under 30MB, and membership documents under 10MB.' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Too many files selected, or an unexpected file field was used.' });
    }
    return res.status(400).json({ error: 'File upload error: ' + err.message });
  }
  if (err.message && (err.message.includes('are allowed') || err.message.startsWith('Unexpected upload field'))) {
    return res.status(400).json({ error: err.message });
  }
  return next(err);
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Missing /uploads files arrive here from express.static (fallthrough: false).
  if (err.status === 404 || err.statusCode === 404) return res.status(404).json({ error: 'Not found.' });

  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) console.error('Unhandled API error:', err);
  res.status(statusCode).json({
    error: statusCode >= 500
      ? 'The server could not complete this request. Please try again or contact the system administrator.'
      : err.message,
  });
});

app.listen(PORT, () => {
  console.log(`\nSLICNA backend API running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health\n`);
});
