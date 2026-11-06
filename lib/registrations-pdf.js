// lib/registrations-pdf.js
// The registrations of one CPD event as a table, shared by the Excel and PDF
// downloads (same columns and order, as in SLNA): confirmed first, then
// pending, then rejected, each oldest first. The PDF is A3 landscape with the
// SLICNA letterhead; long lists continue on new pages with the header repeated.

const PDFDocument = require('pdfkit');
const { COLORS, drawLetterhead, drawFooter } = require('./pdf-letterhead');

const { INK, MUTED, TEAL_DEEP, RULE } = COLORS;
const REGISTERED_AS = { LT: 'Lifetime member', GM: 'General member', OM: 'Ordinary member', PM: 'Partial member', NM: 'Non-member' };
const STATUS_LABELS = { pending: 'Pending', confirmed: 'Confirmed', rejected: 'Rejected' };
const STATUS_ORDER = { confirmed: 0, pending: 1, rejected: 2 };

// width: PDF points (A3 landscape usable width is about 1142); excel: column width.
const COLUMNS = [
  { label: '#', width: 26, excel: 5, value: (r, i) => i + 1 },
  { label: 'Registered as', width: 78, excel: 16, value: (r) => REGISTERED_AS[r.fee_category] },
  { label: 'Membership no.', width: 70, excel: 15, value: (r) => r.membership_number || '' },
  { label: 'NIC', width: 72, excel: 15, value: (r) => r.nic_number },
  { label: 'Name', width: 100, excel: 26, value: (r) => r.full_name },
  { label: 'SLNC no.', width: 58, excel: 13, value: (r) => r.slnc_number || '' },
  { label: 'Email', width: 112, excel: 28, value: (r) => r.email },
  { label: 'Mobile', width: 62, excel: 13, value: (r) => r.mobile },
  { label: 'Name on certificate', width: 100, excel: 26, value: (r) => r.certificate_name },
  { label: 'Postal address', width: 112, excel: 30, value: (r) => r.postal_address },
  { label: 'Workplace', width: 92, excel: 26, value: (r) => r.workplace },
  { label: 'Workplace address', width: 102, excel: 28, value: (r) => r.workplace_address },
  { label: 'Paid by', width: 54, excel: 12, value: (r) => (r.pay_by ? (r.pay_by === 'organisation' ? 'Organisation' : 'Individual') : '') },
  { label: 'Fee (LKR)', width: 50, excel: 11, value: (r) => Number(r.amount_due), money: true },
  { label: 'Status', width: 54, excel: 11, value: (r) => STATUS_LABELS[r.status] },
];

function sortForExport(regs) {
  return [...regs].sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (new Date(a.created_at) - new Date(b.created_at)));
}

function fmtDate(value) {
  if (!value) return '';
  const d = new Date(String(value).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// statusLabel: "All", "Pending", ... (shown in the title).
function writeRegistrationsPdf(stream, event, regs, statusLabel) {
  const left = 24;
  const doc = new PDFDocument({
    size: 'A3', layout: 'landscape', bufferPages: true,
    margins: { top: 30, bottom: 20, left, right: left },
    info: { Title: `Registrations - ${event.title}`, Author: "Sri Lanka Intensive Care Nurses' Association" },
  });
  doc.pipe(stream);
  const width = doc.page.width - left * 2;
  const scale = width / COLUMNS.reduce((s, c) => s + c.width, 0);
  const cols = COLUMNS.map((c) => ({ ...c, w: c.width * scale }));

  let y = drawLetterhead(doc, left, width) + 8;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(`REGISTRATIONS (${statusLabel.toUpperCase()})`, left, y, { width, align: 'center', characterSpacing: 0.6 });
  y += 19;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(TEAL_DEEP).text(event.title, left, y, { width, align: 'center' });
  y = doc.y + 3;
  const facts = [
    fmtDate(event.event_date) + (event.end_date ? ` - ${fmtDate(event.end_date)}` : ''),
    event.time_text, event.location,
    event.cpd_points != null ? `${Number(event.cpd_points)} CPD points` : null,
    `${regs.length} registration${regs.length === 1 ? '' : 's'}`,
  ].filter(Boolean).join('   |   ');
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(facts, left, y, { width, align: 'center' });
  y = doc.y + 12;

  const headH = 22;
  const rowH = 22;
  const bottom = doc.page.height - 50;
  const header = () => {
    let x = left;
    doc.rect(left, y, width, headH).fill(TEAL_DEEP);
    cols.forEach((c) => {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff').text(c.label, x + 4, y + 7.5, { width: c.w - 8, height: headH - 8, ellipsis: true, lineBreak: false });
      x += c.w;
    });
    y += headH;
  };
  header();

  if (!regs.length) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('No registrations.', left, y + 10, { width, align: 'center' });
  }
  regs.forEach((r, i) => {
    if (y + rowH > bottom) {
      doc.addPage();
      y = 30;
      header();
    }
    let x = left;
    cols.forEach((c) => {
      doc.lineWidth(0.5).strokeColor(RULE).rect(x, y, c.w, rowH).stroke();
      const v = c.value(r, i);
      const text = c.money ? v.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v ?? '');
      doc.font('Helvetica').fontSize(7.2).fillColor(INK)
        .text(text || '-', x + 4, y + 7.5, { width: c.w - 8, height: rowH - 8, ellipsis: true, lineBreak: false, align: c.money ? 'right' : 'left' });
      x += c.w;
    });
    y += rowH;
  });

  const range = doc.bufferedPageRange();
  const generated = `Generated on ${fmtDate(new Date().toISOString())}  ·  SLICNA event registrations`;
  for (let p = range.start; p < range.start + range.count; p += 1) {
    doc.switchToPage(p);
    drawFooter(doc, left, width, generated, `Page ${p - range.start + 1} of ${range.count}  ·  Confidential: contains personal data`);
  }
  doc.end();
}

module.exports = { COLUMNS, STATUS_LABELS, sortForExport, writeRegistrationsPdf };
