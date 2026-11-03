// routes/news.js
// News articles: /api/news (public read, admin write).

const { crudRouter } = require('../lib/crud');

module.exports = crudRouter({
  table: 'news',
  orderBy: 'published_at DESC, id DESC',
  image: { column: 'photo_url', field: 'photo', folder: 'news' },
  fields: {
    title: { type: 'text', label: 'Title', required: true, max: 300 },
    published_at: { type: 'date', label: 'Published date', required: true },
    summary: { type: 'text', label: 'Summary', max: 1000 },
    body: { type: 'text', label: 'Full article', max: 50000 },
  },
});
