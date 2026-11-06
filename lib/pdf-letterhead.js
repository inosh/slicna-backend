// lib/pdf-letterhead.js
// The SLICNA letterhead and colours shared by the generated PDFs (ID card
// application, event attendance sheet).

const fs = require('fs');
const path = require('path');

const LOGO = path.join(__dirname, '..', 'assets', 'slicna-logo.png');
const COLORS = {
  INK: '#13242b',
  MUTED: '#6f7f85',
  TEAL: '#0d6b67',
  TEAL_DEEP: '#083f3d',
  MINT: '#ecf6f2',
  LABEL_FILL: '#f4f7f6',
  RULE: '#9fb3b0',
  CORAL: '#e0433a',
};

// Draws the band, logo, name and contact lines; returns the y below the rules.
function drawLetterhead(doc, left, width) {
  const { INK, TEAL, TEAL_DEEP, CORAL } = COLORS;
  doc.rect(0, 0, doc.page.width, 6).fill(TEAL);
  if (fs.existsSync(LOGO)) doc.image(LOGO, left, 22, { fit: [64, 64] });
  const headX = left + 78;
  const headW = width - 78;
  doc.font('Helvetica-Bold').fontSize(15).fillColor(TEAL_DEEP)
    .text("SRI LANKA INTENSIVE CARE NURSES' ASSOCIATION", headX, 26, { width: headW, characterSpacing: 0.2 });
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(TEAL)
    .text('Full member of the World Federation of Critical Care Nurses (WFCCN)', headX, 45, { width: headW });
  doc.font('Helvetica').fontSize(8.5).fillColor(INK)
    .text('Post Basic College of Nursing, Kynsey Road, Colombo, Sri Lanka', headX, 59, { width: headW })
    .text('Phone: 071 338 5768   |   Email: slicna2022@gmail.com', headX, 71, { width: headW });
  doc.moveTo(left, 94).lineTo(left + width, 94).lineWidth(1.6).strokeColor(TEAL).stroke();
  doc.moveTo(left, 97).lineTo(left + width, 97).lineWidth(0.5).strokeColor(CORAL).stroke();
  return 104;
}

// Thin rule, generated-by text and the bottom band.
function drawFooter(doc, left, width, leftText, rightText) {
  const { MUTED, RULE, TEAL } = COLORS;
  const footY = doc.page.height - 36;
  doc.moveTo(left, footY).lineTo(left + width, footY).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.font('Helvetica').fontSize(7).fillColor(MUTED)
    .text(leftText, left, footY + 6, { width: width / 2, lineBreak: false })
    .text(rightText, left + width / 2, footY + 6, { width: width / 2, align: 'right', lineBreak: false });
  doc.rect(0, doc.page.height - 6, doc.page.width, 6).fill(TEAL);
}

module.exports = { COLORS, drawLetterhead, drawFooter };
