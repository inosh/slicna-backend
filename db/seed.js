// db/seed.js
// Loads the website's starting content (the text and photos the site showed
// before it had a backend) into an empty database, copying the photos from
// db/seed-images/ into uploads/.
//
//   npm run seed              - only runs if the content tables are empty
//   npm run seed -- --reset   - wipes all content (not admin users) and its
//                               uploaded files, then seeds again

const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const { UPLOAD_ROOT } = require('../middleware/upload');

const SEED_IMAGES = path.join(__dirname, 'seed-images');
// Membership tables are never touched by seeding.
const CONTENT_TABLES = ['milestones', 'committee_settings', 'committee_members', 'events', 'news', 'album_photos', 'albums', 'community_items', 'community_sections'];
const UPLOAD_FOLDERS = ['about', 'committee', 'events', 'news', 'albums', 'community'];

// Copies a seed image into uploads/<folder>/ and returns its public path.
function upload(folder, seedFile) {
  const dir = path.join(UPLOAD_ROOT, folder);
  fs.mkdirSync(dir, { recursive: true });
  const name = 'seed-' + path.basename(seedFile);
  fs.copyFileSync(path.join(SEED_IMAGES, seedFile), path.join(dir, name));
  return `/uploads/${folder}/${name}`;
}

async function insert(client, table, row) {
  const cols = Object.keys(row);
  const result = await client.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(row)
  );
  return result.rows[0];
}

async function seed(client) {
  await insert(client, 'site_settings', { key: 'about_journey_photo', value: upload('about', 'award-ceremony.jpg') });

  const milestones = [
    ['2022', 'SLICNA is founded', 'ICU nurses come together to form a national association for critical care nursing.'],
    ['Global', 'Full member of WFCCN', 'SLICNA is admitted as a full member of the World Federation of Critical Care Nurses.'],
    ['Award', 'ICONIC Award', 'Named the Best Professional Association of the Year in Sri Lanka.'],
    ['2025', 'SLICNA Award 2025', 'Our first awards to recognise excellence in nursing, plus pre-congress workshops with other nursing bodies.'],
    ['2026', '53.5 CPD points in one year', 'Nine accredited programmes, including an international workshop on infection prevention and control.'],
  ];
  for (const [i, [year_label, title, description]] of milestones.entries()) {
    await insert(client, 'milestones', { year_label, title, description, display_order: (i + 1) * 10 });
  }

  await insert(client, 'committee_settings', { id: 1, term_start_year: 2025, term_end_year: 2027, elected_on: '2025-01-24' });
  const members = [
    ['President', 'G.R.S.S.B. Athurupana', 'president.jpg'],
    ['General Secretary', 'K.A.D.P. Vidyarathna', 'general-secretary.jpg'],
    ['Treasurer', 'A.H.A.D.R. Amunugama', 'treasurer.jpg'],
    ['Chief Organizer', 'K.G.A.S.K. Dharmarathne', 'chief-organizer-1.jpg'],
    ['Chief Organizer', 'R.M.P.B. Senavirathna', 'chief-organizer-2.jpg'],
    ['Vice President', 'Nelka Hettiarachchi', 'vice-president.jpg'],
    ['Vice Secretary', 'H.G.G.P. Samarasinghe', 'vice-secretary.jpg'],
    ['Deputy Treasurer', 'K.A.A. Udayangani', 'deputy-treasurer.jpg'],
    ['Media Secretary', 'K.S.C. Dissanayaka', 'media-secretary.jpg'],
  ];
  for (const [i, [role_title, name, photo]] of members.entries()) {
    await insert(client, 'committee_members', { role_title, name, display_order: (i + 1) * 10, photo_url: upload('committee', 'committee/' + photo) });
  }

  const events = [
    { title: 'Legal & Regulatory Framework for Nurse Managers: Ensuring Safe and Accountable Nursing Services', category: 'cpd', event_date: '2026-01-24', cpd_points: 6, location: 'Colombo', summary: 'The legal duties and regulations nurse managers work within, and how to run safe, accountable services.' },
    { title: 'Professional Boundaries in Nursing Practice: Protecting Patients, Nurses, and the Profession', category: 'cpd', event_date: '2026-03-01', cpd_points: 6.5, location: 'NTC Auditorium, Colombo', summary: 'Where the line sits between caring and over-involvement, and how to hold it.' },
    { title: "Nurses' Professional Identity and the Impact of Institutional & Financial Regulations: Needs and Safeguarding", category: 'cpd', event_date: '2026-03-28', cpd_points: 6.5, location: 'Colombo', summary: 'How institutional and financial rules shape the nursing role, and how to safeguard it.' },
    { title: 'Nursing Approaches to Nutritional Management in Chronic Kidney Disease', category: 'cpd', event_date: '2026-05-23', cpd_points: 6.5, location: 'Colombo', summary: 'Evidence-based nutritional care for patients with chronic kidney disease.' },
    { title: 'Advanced Workshop on Nursing Governance and Professional Accountability', category: 'cpd', event_date: '2026-06-14', cpd_points: 6, location: 'Colombo', summary: 'Governance structures, accountability and leadership for senior nurses.' },
    { title: 'Effective Communication Skills for Professional Nurses', category: 'cpd', event_date: '2026-06-14', cpd_points: 4, location: 'Colombo', summary: 'Clear communication with patients, families and the critical care team.' },
    { title: 'AI for Nurses: Enhancing Patient Care through Intelligent Tools', category: 'cpd', event_date: '2026-07-18', cpd_points: 6.5, location: 'Colombo', summary: 'Practical, safe uses of AI tools in everyday nursing work.' },
    { title: 'Advancing Infection Prevention and Control: Evidence-Based Nursing Practices for Safer Patient Care', category: 'international', event_date: '2026-08-29', time_text: '8.00 a.m. – 4.00 p.m.', cpd_points: 6.5, location: 'New Auditorium, Lady Ridgeway Hospital for Children, Colombo', summary: 'An international CPD workshop held with critical care and infection control nursing bodies from the region.', photo: 'infection-control-workshop.jpg' },
    { title: 'Stress Management for Nursing Professionals: Building Resilience and Well-being', category: 'cpd', event_date: '2026-09-12', cpd_points: 5, location: 'Colombo', summary: 'Recognising stress in high-acuity work and building lasting resilience.' },
    { title: 'World Diabetes Day Celebration Walk', category: 'community', event_date: '2026-11-17', location: 'Kotawa → Maharagama', summary: 'A public awareness walk for World Diabetes Day. Walk with us, and help spread the word.', photo: 'diabetes-walk.jpg' },
    { title: 'Cyber Security – Practical Workshop', category: 'cpd', event_date: '2026-11-28', location: 'To be announced', summary: 'A hands-on CPD workshop on staying safe with patient data, devices and online accounts.' },
  ];
  for (const { photo, ...event } of events) {
    await insert(client, 'events', { ...event, photo_url: photo ? upload('events', photo) : null });
  }

  const news = [
    { title: 'SLICNA named Best Professional Association of the Year', published_at: '2026-02-20', photo: 'iconic-award.jpg', summary: 'SLICNA received the ICONIC Award for the Best Professional Association of the Year in Sri Lanka.', body: 'SLICNA has been recognised with the ICONIC Award for the Best Professional Association of the Year in Sri Lanka.\n\nThe award reflects the work of our members and volunteers: a full calendar of accredited CPD programmes, international workshops, and health promotion in schools and the media.' },
    { title: 'International workshop on infection prevention and control', published_at: '2026-08-30', photo: 'infection-control-workshop.jpg', summary: 'Nurses from Sri Lanka and the region met at Lady Ridgeway Hospital for a full-day CPD workshop on evidence-based infection control.', body: 'SLICNA hosted an international CPD workshop, Advancing Infection Prevention and Control, on 29 August 2026 at the New Auditorium of Lady Ridgeway Hospital for Children.\n\nThe programme was organised with partner nursing bodies from the region and carried 6.5 CPD points.' },
    { title: 'SLICNA Award 2025 honours excellence in nursing', published_at: '2025-12-15', photo: 'award-ceremony.jpg', summary: 'Our annual award ceremony recognised nurses whose work sets the standard for critical care in Sri Lanka.', body: 'The SLICNA Award 2025 recognised nurses for excellence in practice, leadership and education.' },
    { title: 'SLICNA Talent Show: meet the final 12', published_at: '2026-02-10', photo: 'cpd-audience.jpg', summary: "Twelve finalists made it through to the final of SLICNA's first talent show for nurses.", body: 'Twelve finalists reached the final of the SLICNA Talent Show, celebrating the talent of nurses beyond the bedside.' },
    { title: 'On air: SLICNA nurses talk health on national radio', published_at: '2026-06-02', photo: 'radio-awareness.jpg', summary: 'Our members joined radio programmes to share practical health advice with the public.', body: 'SLICNA members have taken part in radio health programmes, sharing practical advice on preventing illness and recognising warning signs early.' },
  ];
  for (const { photo, ...item } of news) {
    await insert(client, 'news', { ...item, photo_url: upload('news', photo) });
  }

  const albums = [
    ['SLICNA Award 2025', [['award-ceremony.jpg', 'Annual Award Ceremony 2025'], ['iconic-award.jpg', 'ICONIC Award – Best Professional Association']]],
    ['CPD programmes', [['cpd-audience.jpg', 'A full house at a CPD programme'], ['team.png', 'The SLICNA team']]],
    ['School Health Programme', [['school-health.jpg', 'Emergency response training for students'], ['school-1.jpg', 'First aid demonstration'], ['school-2.jpg', 'Certificates for participating students']]],
    ['Public awareness', [['radio-awareness.jpg', 'Health talk on radio'], ['suwa-diviya.jpg', 'Suwa Diviya health programme'], ['diabetes-walk.jpg', 'World Diabetes Day walk 2026'], ['childrens-day.jpg', "Children's Day programme"]]],
  ];
  for (const [i, [title, photos]] of albums.entries()) {
    const album = await insert(client, 'albums', { title, display_order: (i + 1) * 10 });
    for (const [j, [file, caption]] of photos.entries()) {
      await insert(client, 'album_photos', { album_id: album.id, url: upload('albums', file), caption, display_order: (j + 1) * 10 });
    }
  }

  const school = await insert(client, 'community_sections', {
    display_order: 10, style: 'feature', eyebrow: 'School Health Programme',
    title: 'අකුරට සවිය: first-minute skills for students',
    body: 'Our nurses visit schools to teach emergency response and first aid, and to talk about healthy habits. Students practise hands-on skills and receive certificates for taking part.',
    bullet_points: 'Emergency response and basic first aid\nRecognising when someone needs urgent help\nHealthy lifestyle and prevention',
    logo_url: upload('community', 'school-health-logo.png'),
  });
  const schoolPhotos = [['school-health.jpg', 'Students practising first aid'], ['school-1.jpg', 'Nurse demonstrating first aid on a student'], ['school-2.jpg', 'Student receiving a certificate']];
  for (const [i, [file, title]] of schoolPhotos.entries()) {
    await insert(client, 'community_items', { section_id: school.id, display_order: (i + 1) * 10, image_url: upload('community', file), title });
  }

  const radio = await insert(client, 'community_sections', {
    display_order: 20, style: 'highlight', eyebrow: 'On air', title: 'Health talks on national radio',
    body: 'SLICNA nurses take part in radio health programmes such as සුව දිවිය. They give clear, practical advice on preventing illness and spotting warning signs early.',
  });
  await insert(client, 'community_items', { section_id: radio.id, display_order: 10, image_url: upload('community', 'radio-awareness.jpg'), title: 'SLICNA nurses during a radio health programme' });

  const campaigns = await insert(client, 'community_sections', {
    display_order: 30, style: 'cards', eyebrow: 'Campaigns', title: 'Public awareness campaigns',
    link_text: 'Upcoming community events', link_url: '/pages/events.html',
  });
  const cards = [
    ['diabetes-walk.jpg', '17 November 2026', 'World Diabetes Day walk', 'A walk from Kotawa to Maharagama to raise awareness of diabetes.'],
    ['suwa-diviya.jpg', 'Radio programme', 'සුව දිවිය', "A health programme that takes our nurses' knowledge into homes across the country."],
    ['childrens-day.jpg', "Children's Day", 'Programmes for children', 'Health promotion at community celebrations for children and families.'],
  ];
  for (const [i, [file, label, title, text]] of cards.entries()) {
    await insert(client, 'community_items', { section_id: campaigns.id, display_order: (i + 1) * 10, image_url: upload('community', file), label, title, text });
  }
}

async function main() {
  const reset = process.argv.includes('--reset');
  const client = await pool.connect();
  try {
    if (reset) {
      await client.query(`TRUNCATE ${CONTENT_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
      await client.query("DELETE FROM site_settings WHERE key = 'about_journey_photo'");
      UPLOAD_FOLDERS.forEach((folder) => fs.rmSync(path.join(UPLOAD_ROOT, folder), { recursive: true, force: true }));
      console.log('Existing content and uploaded files removed.');
    } else {
      const hasAboutPhoto = (await client.query("SELECT 1 FROM site_settings WHERE key = 'about_journey_photo'")).rows[0];
      if (hasAboutPhoto) {
        console.log('Content already exists, so nothing was seeded. Use "npm run seed -- --reset" to wipe and reseed.');
        return;
      }
      for (const table of CONTENT_TABLES) {
        const { rows } = await client.query(`SELECT EXISTS (SELECT 1 FROM ${table}) AS has_rows`);
        if (rows[0].has_rows) {
          console.log(`Table "${table}" already has content, so nothing was seeded. Use "npm run seed -- --reset" to wipe and reseed.`);
          return;
        }
      }
    }

    await client.query('BEGIN');
    await seed(client);
    await client.query('COMMIT');
    console.log('Seed content loaded.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Seeding failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
