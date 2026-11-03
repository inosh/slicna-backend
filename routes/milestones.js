// routes/milestones.js
// About page "Achievements and milestones" timeline: /api/milestones.

const { crudRouter } = require('../lib/crud');

module.exports = crudRouter({
  table: 'milestones',
  orderBy: 'display_order ASC, id ASC',
  fields: {
    year_label: { type: 'text', label: 'Year or label', required: true, max: 40 },
    title: { type: 'text', label: 'Title', required: true, max: 200 },
    description: { type: 'text', label: 'Description', max: 2000 },
    display_order: { type: 'int', label: 'Display order', default: 0 },
  },
});
