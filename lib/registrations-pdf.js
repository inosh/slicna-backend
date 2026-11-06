// lib/registrations-pdf.js
// A4 landscape attendance sheet for a CPD event: SLICNA letterhead, the
// event's facts, then one row per confirmed registration (sorted by the name
// on the certificate) with a column to sign. Long lists continue on new pages
// with the table header repeated.

const PDFDocument = require('pdfkit');
const { COLORS, drawLetterhead, drawFooter } = require('./pdf-letterhead');

const { INK, MUTED, TEAL_DEEP, MINT, RULE } = COLORS;
const LEFT = 36;
const WIDTH = 770;

function fmtDate(value) {
  if (!value) return '';
  const d = new Date(String(value).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const COLUMNS = [
  { label: 'No.', width: 30, value: (r, i) => String(i + 1) },
  { label: 'Name on certificate', width: 200, value: (r) => r.certificate_name },
  { label: 'NIC', width: 90, value: (r) => r.nic_number },
  { label: 'Registered as', width: 116, value: (r, i, labels) => (r.membership_number ? `${r.membership_number}` : labels[r.fee_category]) },
  { label: 'Workplace', width: 170, value: (r) => r.workplace },
  { label: 'Mobile', width: 80, value: (r) => r.mobile },
  { label: 'Signature', width: 84, value: () => '' },
];

function writeRegistrationsPdf(stream, event, regs, feeLabels) {
  const doc = new PDFDocument({
    size: 'A4', layout: 'landscape', bufferPages: true,
    margins: { top: 30, bottom: 20, left: LEFT, right: LEFT },
    info: { Title: `Attendance - ${event.title}`, Author: "Sri Lanka Intensive Care Nurses' Association" },
  });
  doc.pipe(stream);

  let y = drawLetterhead(doc, LEFT, WIDTH) + 8;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text('ATTENDANCE SHEET', LEFT, y, { width: WIDTH, align: 'center', characterSpacing: 0.6 });
  y += 20;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(TEAL_DEEP).text(event.title, LEFT, y, { width: WIDTH, align: 'center' });
  y = doc.y + 4;
  const facts = [
    fmtDate(event.event_date) + (event.end_date ? ` - ${fmtDate(event.end_date)}` : ''),
    event.time_text, event.location,
    event.cpd_points != null ? `${Number(event.cpd_points)} CPD points` : null,
    `${regs.length} confirmed participant${regs.length === 1 ? '' : 's'}`,
  ].filter(Boolean).join('   |   ');
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(facts, LEFT, y, { width: WIDTH, align: 'center' });
  y = doc.y + 12;

  const rowH = 24;
  const bottom = doc.page.height - 50;
  const header = () => {
    let x = LEFT;
    doc.rect(LEFT, y, WIDTH, 20).fill(MINT);
    COLUMNS.forEach((c) => {
      doc.lineWidth(0.5).strokeColor(RULE).rect(x, y, c.width, 20).stroke();
      doc.font('Helvetica-Bold').fontSize(8).fillColor(TEAL_DEEP).text(c.label.toUpperCase(), x + 5, y + 6.5, { width: c.width - 10, lineBreak: false });
      x += c.width;
    });
    y += 20;
  };
  header();

  if (!regs.length) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('No confirmed registrations yet.', LEFT, y + 10, { width: WIDTH, align: 'center' });
  }
  regs.forEach((r, i) => {
    if (y + rowH > bottom) {
      doc.addPage();
      y = 36;
      header();
    }
    let x = LEFT;
    COLUMNS.forEach((c) => {
      doc.lineWidth(0.5).strokeColor(RULE).rect(x, y, c.width, rowH).stroke();
      doc.font(c.label === 'Name on certificate' ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(INK)
        .text(c.value(r, i, feeLabels) || '', x + 5, y + 8, { width: c.width - 10, height: 11, ellipsis: true, lineBreak: false });
      x += c.width;
    });
    y += rowH;
  });

  // Footer with page numbers on every page.
  const range = doc.bufferedPageRange();
  const generated = `Generated on ${fmtDate(new Date().toISOString())}  ·  SLICNA event registrations`;
  for (let p = range.start; p < range.start + range.count; p += 1) {
    doc.switchToPage(p);
    drawFooter(doc, LEFT, WIDTH, generated, `Page ${p - range.start + 1} of ${range.count}  ·  Confidential: contains personal data`);
  }
  doc.end();
}

module.exports = { writeRegistrationsPdf };
