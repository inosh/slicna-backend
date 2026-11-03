// lib/crud.js
// Builds the standard list / get / create / update / delete routes for one
// table, so each content type (news, events, milestones, ...) only declares
// its fields. Reads are public; writes need an admin token (requireAuth).
//
// Field spec:  { type: 'text' | 'date' | 'int' | 'number' | 'enum',
//                label, required, max, min, values (enum), default }
// Image spec:  { column: 'photo_url', field: 'photo', folder: 'news' }
//   - create/update accept one image in the multipart field `field`
//   - update with remove_image=true clears it
//   - replaced or removed images are deleted from disk

const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { imageUpload, publicPathFor } = require('../middleware/upload');
const { deleteUpload, discardRequestFiles } = require('./files');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validationError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function notFound(res) {
  return res.status(404).json({ error: 'Not found.' });
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Turns a request body into clean column values, or throws a 400 with a readable message.
function parseFields(body, fields) {
  const values = {};
  for (const [name, spec] of Object.entries(fields)) {
    const label = spec.label || name;
    const raw = body[name] === undefined || body[name] === null ? '' : String(body[name]).trim();

    if (raw === '') {
      if (spec.required) throw validationError(`${label} is required.`);
      values[name] = spec.default !== undefined ? spec.default : null;
      continue;
    }

    switch (spec.type) {
      case 'date':
        if (!DATE_RE.test(raw) || Number.isNaN(Date.parse(raw))) throw validationError(`${label} must be a valid date.`);
        values[name] = raw;
        break;
      case 'int':
      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n) || (spec.type === 'int' && !Number.isInteger(n))) {
          throw validationError(`${label} must be a ${spec.type === 'int' ? 'whole number' : 'number'}.`);
        }
        if (spec.min !== undefined && n < spec.min) throw validationError(`${label} must be at least ${spec.min}.`);
        if (spec.max !== undefined && n > spec.max) throw validationError(`${label} must be at most ${spec.max}.`);
        values[name] = n;
        break;
      }
      case 'enum':
        if (!spec.values.includes(raw)) throw validationError(`${label} must be one of: ${spec.values.join(', ')}.`);
        values[name] = raw;
        break;
      default:
        if (spec.max && raw.length > spec.max) throw validationError(`${label} must be at most ${spec.max} characters.`);
        values[name] = raw;
    }
  }
  return values;
}

function crudRouter({ table, fields, image, orderBy = 'id', validate }) {
  const router = express.Router();
  const parseBody = image ? imageUpload(image.folder).single(image.field) : multer().none();

  router.get('/', async (req, res, next) => {
    try {
      const result = await pool.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
      res.json(result.rows);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);
    try {
      const result = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      if (!result.rows[0]) return notFound(res);
      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', requireAuth, parseBody, async (req, res, next) => {
    try {
      const values = parseFields(req.body, fields);
      if (validate) validate(values);
      if (image && req.file) values[image.column] = publicPathFor(image.folder, req.file);

      const columns = Object.keys(values);
      const placeholders = columns.map((_, i) => `$${i + 1}`);
      const result = await pool.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
        Object.values(values)
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      discardRequestFiles(req);
      next(err);
    }
  });

  router.put('/:id', requireAuth, parseBody, async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) {
      discardRequestFiles(req);
      return notFound(res);
    }
    try {
      const existing = (await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];
      if (!existing) {
        discardRequestFiles(req);
        return notFound(res);
      }

      const values = parseFields(req.body, fields);
      if (validate) validate(values);

      let oldImage = null;
      if (image && req.file) {
        values[image.column] = publicPathFor(image.folder, req.file);
        oldImage = existing[image.column];
      } else if (image && req.body.remove_image === 'true') {
        values[image.column] = null;
        oldImage = existing[image.column];
      }

      const columns = Object.keys(values);
      const sets = columns.map((col, i) => `${col} = $${i + 1}`);
      const result = await pool.query(
        `UPDATE ${table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $${columns.length + 1} RETURNING *`,
        [...Object.values(values), id]
      );
      deleteUpload(oldImage);
      res.json(result.rows[0]);
    } catch (err) {
      discardRequestFiles(req);
      next(err);
    }
  });

  router.delete('/:id', requireAuth, async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);
    try {
      const result = await pool.query(`DELETE FROM ${table} WHERE id = $1 RETURNING *`, [id]);
      if (!result.rows[0]) return notFound(res);
      if (image) deleteUpload(result.rows[0][image.column]);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { crudRouter, parseFields, parseId, validationError };
