// routes/events.js
// All events (CPD programmes, international workshops, community events):
// /api/events. The CPD page uses the events that have cpd_points.

const { crudRouter, validationError } = require('../lib/crud');

module.exports = crudRouter({
  table: 'events',
  orderBy: 'event_date ASC, id ASC',
  image: { column: 'photo_url', field: 'photo', folder: 'events' },
  fields: {
    title: { type: 'text', label: 'Title', required: true, max: 300 },
    category: { type: 'enum', label: 'Category', required: true, values: ['cpd', 'international', 'community'] },
    event_date: { type: 'date', label: 'Date', required: true },
    end_date: { type: 'date', label: 'End date' },
    time_text: { type: 'text', label: 'Time', max: 100 },
    location: { type: 'text', label: 'Venue', max: 300 },
    cpd_points: { type: 'number', label: 'CPD points', min: 0, max: 100 },
    summary: { type: 'text', label: 'Summary', max: 1000 },
    body: { type: 'text', label: 'Details', max: 20000 },
  },
  validate(values) {
    if (values.end_date && values.end_date < values.event_date) {
      throw validationError('End date cannot be before the start date.');
    }
  },
});
