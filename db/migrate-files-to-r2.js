// db/migrate-files-to-r2.js
// One-time move of the files saved on disk before R2 (uploads/ and
// private-uploads/) into the R2 buckets, under the same names, so the paths
// and keys already in the database keep working without any change:
//   uploads/news/abc.jpg                      -> public bucket   news/abc.jpg   (DB: "/uploads/news/abc.jpg")
//   private-uploads/membership/renewals/1/x.pdf -> private bucket membership/renewals/1/x.pdf (DB: same key)
//
//   node db/migrate-files-to-r2.js           check only: what would be copied, and what the database refers to
//   node db/migrate-files-to-r2.js --apply   copy, then check every file the database refers to is in R2
//
// Safe to re-run: files already in R2 with the same size are skipped. The
// local folders are left as they are (delete them yourself once you're happy).

const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const storage = require('../lib/storage');

const ROOTS = [
  { which: 'public', dir: path.join(__dirname, '..', 'uploads') },
  { which: 'private', dir: path.join(__dirname, '..', 'private-uploads') },
];

// Every file under dir, as keys with forward slashes ("news/abc.jpg").
function filesUnder(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name !== '.gitkeep') out.push(path.relative(dir, p).split(path.sep).join('/'));
  });
  walk(dir);
  return out;
}

// What the database refers to: "/uploads/..." in any text column (photos,
// albums, pictures inside articles, settings...), and private *_key columns.
async function referencedFiles() {
  const cols = (await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('text', 'character varying')`
  )).rows;
  const pub = new Map();
  const priv = new Map();
  for (const { table_name: t, column_name: c } of cols) {
    const isKey = /(^|_)key$/.test(c) && c !== 'key';
    const rows = (await pool.query(
      isKey ? `SELECT "${c}" AS v FROM "${t}" WHERE "${c}" IS NOT NULL` : `SELECT "${c}" AS v FROM "${t}" WHERE "${c}" LIKE '%/uploads/%'`
    )).rows;
    rows.forEach(({ v }) => {
      if (isKey) { if (/^(membership|events)\//.test(v)) priv.set(v, `${t}.${c}`); return; }
      (String(v).match(/\/uploads\/[^"'\s<>)]+/g) || []).forEach((p) => {
        const key = storage.publicKeyFromPath(p);
        if (key) pub.set(key, `${t}.${c}`);
      });
    });
  }
  return { public: pub, private: priv };
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (storage.missing.length) throw new Error(`Missing R2 settings: ${storage.missing.join(', ')}`);

  for (const { which, dir } of ROOTS) {
    const keys = filesUnder(dir);
    let copied = 0;
    let skipped = 0;
    let bytes = 0;
    for (const key of keys) {
      const file = path.join(dir, key);
      const size = fs.statSync(file).size;
      const head = await storage.get(which, key).then((o) => { if (o) o.Body.destroy(); return o; }).catch(() => null);
      if (head && Number(head.ContentLength) === size) { skipped += 1; continue; }
      if (apply) {
        await storage.put(which, key, fs.createReadStream(file), storage.contentTypeFor(key));
        process.stdout.write('.');
      }
      copied += 1;
      bytes += size;
    }
    if (apply && copied) process.stdout.write('\n');
    console.log(`${which}: ${keys.length} local files, ${copied} ${apply ? 'copied' : 'to copy'} (${(bytes / 1048576).toFixed(1)} MB), ${skipped} already in R2`);
  }

  const refs = await referencedFiles();
  for (const which of ['public', 'private']) {
    const missing = [];
    for (const [key, where] of refs[which]) {
      if (!(await storage.exists(which, key))) missing.push(`${key}  (${where})`);
    }
    console.log(`${which}: the database refers to ${refs[which].size} files; ${missing.length ? `${missing.length} not in R2${apply ? '' : ' yet'}:` : 'all are in R2.'}`);
    missing.forEach((m) => console.log('   - ' + m));
  }
  if (!apply) console.log('\nCheck only: run again with --apply to copy.');
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());
