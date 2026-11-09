// db/import-legacy-members.js
// Imports members from the old records (the cleansed Excel workbook) as legacy
// members: number, category, names, member since (year) and valid until.
// NIC and contact details are added later (admin "Edit details", or the
// member's first renewal).
//
//   node db/import-legacy-members.js "<workbook.xlsx>"          check only (nothing saved)
//   node db/import-legacy-members.js "<workbook.xlsx>" --apply  import
//
// The first sheet needs these headings: Category, Membership number (website),
// Name in full, Name with initials, Member since (year), Valid until
// ("Lifetime" or a date). Rows whose number is already in the database are
// skipped. Everything is imported in one transaction: all rows or none.

const ExcelJS = require('exceljs');
const pool = require('./pool');
const M = require('../lib/membership');

const HEADINGS = {
  category: 'Category',
  number: 'Membership number (website)',
  full_name: 'Name in full',
  name_with_initials: 'Name with initials',
  year: 'Member since (year)',
  valid_until: 'Valid until',
};

const text = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return String(v.text ?? v.result ?? (v.richText ? v.richText.map((t) => t.text).join('') : ''));
  return String(v);
};
const clean = (s) => text(s).replace(/\s+/g, ' ').trim();

async function main() {
  const [file, flag] = process.argv.slice(2);
  if (!file) throw new Error('Usage: node db/import-legacy-members.js "<workbook.xlsx>" [--apply]');
  const apply = flag === '--apply';

  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(file);
  const sheet = book.worksheets[0];
  const header = sheet.getRow(1).values.map(clean);
  const col = Object.fromEntries(Object.entries(HEADINGS).map(([k, h]) => {
    const i = header.indexOf(h);
    if (i < 1) throw new Error(`Column "${h}" not found in the first sheet.`);
    return [k, i];
  }));

  const rows = [];
  const problems = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const get = (k) => clean(row.getCell(col[k]).value);
    if (!get('number') && !get('full_name')) return; // empty line
    const where = `row ${n}`;
    const category = get('category').toUpperCase();
    const parsed = M.parseMembershipNumber(get('number'));
    const fullName = get('full_name');
    const initials = get('name_with_initials');
    const year = Number(get('year'));
    const validRaw = get('valid_until');
    if (!M.CATEGORIES[category]) problems.push(`${where}: unknown category "${category}"`);
    if (!parsed || !parsed.number) problems.push(`${where}: membership number "${get('number')}" is not like GM 0001/23`);
    else if (parsed.category !== category) problems.push(`${where}: ${parsed.number} does not match category ${category}`);
    if (!fullName) problems.push(`${where}: no name in full`);
    if (!initials) problems.push(`${where}: no name with initials`);
    if (!(year >= 1990 && year <= Number(M.today().slice(0, 4)))) problems.push(`${where}: member since "${get('year')}" is not a year`);
    let validUntil = null;
    if (category === 'LT') {
      if (validRaw && !/^lifetime$/i.test(validRaw)) problems.push(`${where}: a Lifetime member should have "Lifetime" as valid until`);
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(validRaw)) {
      problems.push(`${where}: valid until "${validRaw}" is not a date (YYYY-MM-DD)`);
    } else {
      validUntil = validRaw;
    }
    rows.push({
      where,
      membership_number: parsed && parsed.number,
      category,
      full_name: fullName,
      name_with_initials: initials,
      joined_on: `${year}-01-01`,
      valid_until: validUntil,
    });
  });

  // Duplicates within the sheet.
  const seen = new Map();
  rows.forEach((r) => {
    const k = M.compactNumber(r.membership_number);
    if (seen.has(k)) problems.push(`${r.where}: ${r.membership_number} also on ${seen.get(k)}`);
    else seen.set(k, r.where);
  });

  // Already in the database (skipped), and reserved numbers (a problem).
  const existing = new Set((await pool.query("SELECT regexp_replace(upper(membership_number), '[^A-Z0-9]', '', 'g') AS n FROM members")).rows.map((r) => r.n));
  const retired = new Set((await pool.query("SELECT regexp_replace(upper(membership_number), '[^A-Z0-9]', '', 'g') AS n FROM retired_membership_numbers")).rows.map((r) => r.n));
  const toImport = rows.filter((r) => r.membership_number && !existing.has(M.compactNumber(r.membership_number)));
  const skipped = rows.length - toImport.length;
  toImport.forEach((r) => { if (retired.has(M.compactNumber(r.membership_number))) problems.push(`${r.where}: ${r.membership_number} is a reserved (retired) number`); });

  const byCat = (list) => Object.keys(M.CATEGORIES).map((c) => `${c} ${list.filter((r) => r.category === c).length}`).join(', ');
  console.log(`Rows in the sheet: ${rows.length} (${byCat(rows)})`);
  console.log(`Already in the database (skipped): ${skipped}`);
  console.log(`To import: ${toImport.length} (${byCat(toImport)})`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s), nothing imported:`);
    problems.forEach((p) => console.log('  - ' + p));
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    console.log('\nCheck only: run again with --apply to import.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of toImport) {
      await client.query(
        `INSERT INTO members (membership_number, category, full_name, name_with_initials, joined_on, valid_until, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'legacy')`,
        [r.membership_number, r.category, r.full_name, r.name_with_initials, r.joined_on, r.valid_until]
      );
    }
    await client.query('COMMIT');
    console.log(`\nImported ${toImport.length} legacy members.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());
