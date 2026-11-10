// lib/id-application-pdf.js
// Builds the one-page A4 "Membership ID Card Application" PDF for a member:
// SLICNA letterhead, the passport photo beside the membership facts, then the
// personal, contact and professional details in bordered tables and a box for
// office use. Also names the downloads ("GM-0012-26-I-A-Perera-ID-Application.pdf").

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { CATEGORIES } = require('./membership');
const { resolveKey } = require('./private-files');
const { COLORS, drawLetterhead, drawFooter } = require('./pdf-letterhead');

const { INK, MUTED, TEAL, TEAL_DEEP, MINT, LABEL_FILL, RULE } = COLORS;

const LEFT = 40;
const WIDTH = 515;

function fmtDate(value) {
  if (!value) return '';
  const d = new Date(String(value instanceof Date ? value.toISOString() : value).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const join = (...parts) => parts.filter((p) => p !== null && p !== undefined && String(p).trim() !== '').join(', ');

// "GM 0012/26" + "I. A. Perera" -> "GM-0012-26-I-A-Perera"
function filePart(value) {
  return String(value || '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
function idFileBase(member) {
  return [filePart(member.membership_number) || 'SLICNA', filePart(member.name_with_initials || member.full_name)].filter(Boolean).join('-');
}
const idApplicationFilename = (member) => `${idFileBase(member)}-ID-Application.pdf`;
const idPhotoFilename = (member, key) => `${idFileBase(member)}-ID-Photo${path.extname(String(key || '')).toLowerCase() || '.jpg'}`;

// member: members row; app: the linked membership_applications row or null;
// meta: { generatedBy } (admin username, optional).
function writeIdApplicationPdf(stream, member, app, meta = {}) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 30, bottom: 20, left: LEFT, right: LEFT },
    info: { Title: `ID card application - ${member.membership_number}`, Author: "Sri Lanka Intensive Care Nurses' Association" },
  });
  doc.pipe(stream);
  const a = app || {};
  const isPm = member.category === 'PM';
  const value = (v) => (v === null || v === undefined || String(v).trim() === '' ? '-' : String(v));

  // ---------- Letterhead ----------
  drawLetterhead(doc, LEFT, WIDTH);

  // ---------- Title ----------
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK)
    .text('MEMBERSHIP ID CARD APPLICATION', LEFT, 110, { width: WIDTH, align: 'center', characterSpacing: 0.6 });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text(a.reference_number ? `Prepared from online application ${a.reference_number}` : 'Prepared from the SLICNA member register', LEFT, 128, { width: WIDTH, align: 'center' });

  // ---------- Table helpers ----------
  let y = 148;
  const cell = (x, w, h, fill) => {
    if (fill) doc.rect(x, y, w, h).fill(fill);
    doc.lineWidth(0.5).strokeColor(RULE).rect(x, y, w, h).stroke();
  };
  const label = (text, x, w, h) => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(TEAL_DEEP).text(text, x + 6, y + (h - 9) / 2, { width: w - 10, height: h - 4, ellipsis: true });
  };
  const val = (text, x, w, h, { size = 9, bold = false, color = INK } = {}) => {
    const lines = h >= 30 ? 2 : 1;
    const top = lines > 1 ? y + 5 : y + (h - size - 1) / 2;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color)
      .text(value(text), x + 7, top, { width: w - 12, height: lines * (size + 3), ellipsis: true, lineGap: 1 });
  };
  const section = (title) => {
    y += 10;
    doc.rect(LEFT, y, WIDTH, 17).fill(MINT);
    doc.rect(LEFT, y, 3, 17).fill(TEAL);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(TEAL_DEEP).text(title.toUpperCase(), LEFT + 10, y + 5, { width: WIDTH - 20, characterSpacing: 0.8 });
    y += 17;
  };
  const row = (l, v, h = 20, opts) => {
    cell(LEFT, 150, h, LABEL_FILL);
    cell(LEFT + 150, WIDTH - 150, h);
    label(l, LEFT, 150, h);
    val(v, LEFT + 150, WIDTH - 150, h, opts);
    y += h;
  };
  const row2 = (l1, v1, l2, v2, h = 20) => {
    const lw = 150;
    const vw = (WIDTH - lw * 2 + 50) / 2; // 157.5 + 25 on each side, second label narrower
    const l2w = lw - 50;
    cell(LEFT, lw, h, LABEL_FILL);
    cell(LEFT + lw, vw, h);
    cell(LEFT + lw + vw, l2w, h, LABEL_FILL);
    cell(LEFT + lw + vw + l2w, vw, h);
    label(l1, LEFT, lw, h);
    val(v1, LEFT + lw, vw, h);
    label(l2, LEFT + lw + vw, l2w, h);
    val(v2, LEFT + lw + vw + l2w, vw, h);
    y += h;
  };

  // ---------- Membership facts + photo ----------
  section('Membership');
  const blockTop = y;
  const photoW = 112;
  const factsW = WIDTH - photoW - 12;
  const facts = [
    ['Membership number', member.membership_number, { size: 13, bold: true, color: TEAL_DEEP }],
    ['Category', `${CATEGORIES[member.category]} (${member.category})`],
    ['Member since', fmtDate(member.joined_on)],
    ['Valid until', member.valid_until ? fmtDate(member.valid_until) : 'Lifetime membership'],
    ['Application reference', a.reference_number || 'Added by an admin'],
  ];
  const factH = 28;
  facts.forEach(([l, v, opts]) => {
    cell(LEFT, 140, factH, LABEL_FILL);
    cell(LEFT + 140, factsW - 140, factH);
    label(l, LEFT, 140, factH);
    val(v, LEFT + 140, factsW - 140, factH, opts);
    y += factH;
  });

  // Passport photo, framed, to the right of the facts.
  const photoX = LEFT + WIDTH - photoW;
  const photoH = factH * facts.length;
  doc.lineWidth(0.8).strokeColor(TEAL).rect(photoX, blockTop, photoW, photoH).stroke();
  const photoPath = resolveKey(member.photo_key || a.photo_key);
  if (photoPath && fs.existsSync(photoPath)) {
    try {
      doc.image(photoPath, photoX + 4, blockTop + 4, { fit: [photoW - 8, photoH - 8], align: 'center', valign: 'center' });
    } catch (err) {
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('Photo could not be read', photoX + 8, blockTop + photoH / 2 - 5, { width: photoW - 16, align: 'center' });
    }
  } else {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('Affix passport-size photograph', photoX + 10, blockTop + photoH / 2 - 10, { width: photoW - 20, align: 'center' });
  }

  // ---------- Personal ----------
  section('Personal details');
  row('Name in full', member.full_name, 22, { bold: true });
  row('Name with initials', [member.title, member.name_with_initials].filter(Boolean).join(' '));
  row2('NIC number', member.nic_number, 'Date of birth', fmtDate(member.date_of_birth));
  row2('Sex', member.sex, 'Marital status', a.marital_status);

  // ---------- Contact ----------
  section('Contact details');
  row('Permanent address', a.permanent_address, 30);
  row2('Mobile', member.mobile, 'WhatsApp', member.whatsapp);
  row2('Residential phone', a.residential_phone, 'Office phone', a.office_phone);
  row('Email', member.email);

  // ---------- Professional / studies ----------
  section(isPm ? 'Studies' : 'Professional details');
  if (isPm) {
    row('Nursing school / university', member.current_working_place || a.nursing_school);
    row2('Student number', a.student_number, 'Registered on', fmtDate(a.institute_registration_date));
    row('Institution address', a.official_address, 30);
  } else {
    row2('Designation', member.designation, 'Batch', a.batch);
    row('Current working place', member.current_working_place);
    row('Official address', a.official_address, 30);
    row2('SLNC registration no.', a.slnc_not_registered ? 'Not registered yet' : a.slnc_number, 'Registered on', fmtDate(a.slnc_date));
    row('Nursing school', a.nursing_school);
    if (member.category === 'LT') row('ICU training (PBCN)', join(a.icu_training_type, a.icu_training_batch && `batch ${a.icu_training_batch}`, a.icu_training_year));
  }
  row2('SLNA membership no.', a.slna_not_member ? 'Not an SLNA member yet' : a.slna_number, 'SLNA since', fmtDate(a.slna_date));

  // ---------- Office use ----------
  section('For office use');
  const third = WIDTH / 3;
  const boxH = 44;
  ['Checked by (name & signature)', 'Approved by (signature & date)', 'ID card issued on'].forEach((text, i) => {
    cell(LEFT + third * i, third, boxH);
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(text, LEFT + third * i + 6, y + boxH - 12, { width: third - 12 });
  });
  y += boxH;

  // ---------- Footer ----------
  const generated = `Generated on ${fmtDate(new Date().toISOString())}${meta.generatedBy ? ` by ${meta.generatedBy}` : ''}`;
  drawFooter(doc, LEFT, WIDTH, `${generated}  ·  SLICNA membership records`, 'Confidential: contains personal data');

  doc.end();
}

module.exports = { writeIdApplicationPdf, idApplicationFilename, idPhotoFilename };
