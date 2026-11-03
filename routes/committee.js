// routes/committee.js
// Executive Committee:
//   GET /api/committee            public: term settings + members in display order
//   PUT /api/committee/settings   admin: term years and election date
//   /api/committee/members        admin CRUD for members (with photo)

const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { crudRouter, parseFields, validationError } = require('../lib/crud');

const router = express.Router();

const SETTINGS_FIELDS = {
  term_start_year: { type: 'int', label: 'Term start year', required: true, min: 2000, max: 2100 },
  term_end_year: { type: 'int', label: 'Term end year', required: true, min: 2000, max: 2100 },
  elected_on: { type: 'date', label: 'Election date' },
};

router.get('/', async (req, res, next) => {
  try {
    const settings = (await pool.query('SELECT term_start_year, term_end_year, elected_on FROM committee_settings WHERE id = 1')).rows[0] || {};
    const members = (await pool.query('SELECT * FROM committee_members ORDER BY display_order ASC, id ASC')).rows;
    res.json({ ...settings, members });
  } catch (err) {
    next(err);
  }
});

router.put('/settings', requireAuth, multer().none(), async (req, res, next) => {
  try {
    const values = parseFields(req.body, SETTINGS_FIELDS);
    if (values.term_end_year < values.term_start_year) throw validationError('The term cannot end before it starts.');

    const result = await pool.query(
      `INSERT INTO committee_settings (id, term_start_year, term_end_year, elected_on)
       VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET term_start_year = $1, term_end_year = $2, elected_on = $3, updated_at = now()
       RETURNING term_start_year, term_end_year, elected_on`,
      [values.term_start_year, values.term_end_year, values.elected_on]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.use('/members', crudRouter({
  table: 'committee_members',
  orderBy: 'display_order ASC, id ASC',
  image: { column: 'photo_url', field: 'photo', folder: 'committee' },
  fields: {
    role_title: { type: 'text', label: 'Position', required: true, max: 100 },
    name: { type: 'text', label: 'Name', required: true, max: 255 },
    designation: { type: 'text', label: 'Designation', max: 150 },
    display_order: { type: 'int', label: 'Display order', default: 0 },
  },
}));

module.exports = router;
