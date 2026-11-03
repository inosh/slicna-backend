// routes/community.js
// Community page content:
//   GET /api/community              public: sections in order, each with its items
//   /api/community/sections         admin CRUD (logo image)
//   /api/community/items            admin CRUD (photo or card image)

const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { crudRouter, parseId } = require('../lib/crud');
const { deleteUpload } = require('../lib/files');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const sections = (await pool.query('SELECT * FROM community_sections ORDER BY display_order ASC, id ASC')).rows;
    const items = (await pool.query('SELECT * FROM community_items ORDER BY display_order ASC, id ASC')).rows;
    res.json(sections.map((section) => ({ ...section, items: items.filter((item) => item.section_id === section.id) })));
  } catch (err) {
    next(err);
  }
});

// Deleting a section also deletes its items (ON DELETE CASCADE), so remove
// their image files first; the section's own logo is handled by crudRouter.
router.delete('/sections/:id', requireAuth, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return next();
  try {
    const items = (await pool.query('SELECT image_url FROM community_items WHERE section_id = $1', [id])).rows;
    items.forEach((item) => deleteUpload(item.image_url));
    next();
  } catch (err) {
    next(err);
  }
});

router.use('/sections', crudRouter({
  table: 'community_sections',
  orderBy: 'display_order ASC, id ASC',
  image: { column: 'logo_url', field: 'logo', folder: 'community' },
  fields: {
    style: { type: 'enum', label: 'Layout', required: true, values: ['feature', 'highlight', 'cards'] },
    eyebrow: { type: 'text', label: 'Small heading', max: 100 },
    title: { type: 'text', label: 'Title', required: true, max: 200 },
    body: { type: 'text', label: 'Text', max: 5000 },
    bullet_points: { type: 'text', label: 'Bullet points', max: 3000 },
    link_text: { type: 'text', label: 'Link text', max: 100 },
    link_url: { type: 'text', label: 'Link address', max: 300 },
    display_order: { type: 'int', label: 'Display order', default: 0 },
  },
}));

router.use('/items', crudRouter({
  table: 'community_items',
  orderBy: 'section_id ASC, display_order ASC, id ASC',
  image: { column: 'image_url', field: 'image', folder: 'community' },
  fields: {
    section_id: { type: 'int', label: 'Section', required: true, min: 1 },
    label: { type: 'text', label: 'Label', max: 100 },
    title: { type: 'text', label: 'Title', max: 200 },
    text: { type: 'text', label: 'Text', max: 2000 },
    display_order: { type: 'int', label: 'Display order', default: 0 },
  },
}));

module.exports = router;
