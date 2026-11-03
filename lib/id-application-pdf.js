// lib/id-application-pdf.js
// Builds the A4 "Membership ID Card Application" PDF for a member: SLICNA
// header, the member's photo, and their membership and personal details in a
// bordered table, ready to print and send for the ID card.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { CATEGORIES } = require('./membership');
const { resolveKey } = require('./private-files');

const LOGO = path.join(__dirname, '..', 'assets', 'slicna-logo.png');
const INK = '#13242b';
const TEAL = '#0d6b67';

function fmtDate(value) {
  if (!value) return '';
  const d = new Date(String(value).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// member: members row; app: the linked membership_applications row or null.
function writeIdApplicationPdf(stream, member, app) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 36, bottom: 36, left: 40, right: 40 } });
  doc.pipe(stream);
  const left = 40;
  const width = 515;

  // Header
  if (fs.existsSync(LOGO)) doc.image(LOGO, left, 34, { width: 62 });
  doc.font('Helvetica-Bold').fontSize(15).fillColor(TEAL).text("SRI LANKA INTENSIVE CARE NURSES' ASSOCIATION", left + 74, 40, { width: width - 74 });
  doc.font('Helvetica').fontSize(9).fillColor(INK)
    .text('Post Basic College of Nursing, Kynsey Road, Colombo, Sri Lanka', left + 74, 60)
    .text('slicna2022@gmail.com  ·  www.slicna.lk', left + 74, 73);
  doc.moveTo(left, 104).lineTo(left + width, 104).lineWidth(1).strokeColor(TEAL).stroke();

  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text('MEMBERSHIP ID CARD APPLICATION', left, 120, { width, align: 'center' });

  // Photo box (top right) next to the key membership facts
  const photoX = left + width - 120;
  const photoY = 150;
  doc.lineWidth(0.6).strokeColor('#444').rect(photoX, photoY, 120, 150).stroke();
  const photoPath = resolveKey(member.photo_key);
  if (photoPath && fs.existsSync(photoPath)) {
    try {
      doc.image(photoPath, photoX + 2, photoY + 2, { fit: [116, 146], align: 'center', valign: 'center' });
    } catch (err) {
      doc.fontSize(8).text('Photo could not be read', photoX + 10, photoY + 70, { width: 100, align: 'center' });
    }
  } else {
    doc.font('Helvetica').fontSize(8).fillColor('#777').text('Paste passport-size photo here', photoX + 10, photoY + 66, { width: 100, align: 'center' });
  }

  const keyFacts = [
    ['Membership number', member.membership_number],
    ['Category', CATEGORIES[member.category]],
    ['Member since', fmtDate(member.joined_on)],
    ['Valid until', member.valid_until ? fmtDate(member.valid_until) : 'Lifetime'],
  ];
  let y = photoY;
  const factWidth = width - 140;
  keyFacts.forEach(([label, value]) => {
    doc.lineWidth(0.45).strokeColor('#222').rect(left, y, 150, 37).stroke().rect(left + 150, y, factWidth - 150, 37).stroke();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(label, left + 8, y + 13, { width: 136 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(TEAL).text(value || '', left + 158, y + 12, { width: factWidth - 166 });
    y += 37.5;
  });

  // Personal and professional details
  const rows = [
    ['Name in full', member.full_name],
    ['Name with initials', [member.title, member.name_with_initials].filter(Boolean).join(' ')],
    ['NIC number', member.nic_number],
    ['Date of birth', fmtDate(member.date_of_birth)],
    ['Sex', member.sex],
    ['Designation', member.designation],
    ['Current working place', member.current_working_place],
    ['Permanent address', app && app.permanent_address],
    ['Mobile', member.mobile],
    ['Email', member.email],
    ['SLNC registration no.', app && app.slnc_number],
    ['Nursing school / university', app && app.nursing_school],
  ];
  y = 320;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(TEAL).text('MEMBER DETAILS', left, y);
  y += 16;
  rows.forEach(([label, value]) => {
    const h = 26;
    doc.lineWidth(0.45).strokeColor('#222').rect(left, y, 170, h).stroke().rect(left + 170, y, width - 170, h).stroke();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(label, left + 8, y + 9, { width: 156 });
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(value || '', left + 178, y + 8.5, { width: width - 186, height: h - 10, ellipsis: true });
    y += h;
  });

  // Office use
  y += 26;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(TEAL).text('FOR OFFICE USE', left, y);
  y += 16;
  const half = width / 2;
  doc.lineWidth(0.45).strokeColor('#222').rect(left, y, half, 60).stroke().rect(left + half, y, half, 60).stroke();
  doc.font('Helvetica').fontSize(8.5).fillColor(INK)
    .text('Approved by (signature & date)', left + 8, y + 46)
    .text('ID card issued on', left + half + 8, y + 46);

  doc.font('Helvetica').fontSize(7.5).fillColor('#777')
    .text(`Generated on ${fmtDate(new Date().toISOString())}${app ? ` from application ${app.reference_number}` : ''}.`, left, 790, { width, align: 'center' });

  doc.end();
}

module.exports = { writeIdApplicationPdf };
