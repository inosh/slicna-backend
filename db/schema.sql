-- ============================================================
-- SLICNA backend - database schema
-- Run once against an empty database:  npm run init-db
-- (or paste into pgAdmin's Query Tool for slicna_db).
-- Every statement is IF NOT EXISTS, so re-running is safe.
-- ============================================================

-- Table: public.users
-- Staff accounts for the admin panel. Create with: npm run create-admin

CREATE TABLE IF NOT EXISTS public.users
(
    id serial NOT NULL,
    username character varying(50) NOT NULL,
    password_hash character varying(255) NOT NULL,
    role character varying(30) NOT NULL DEFAULT 'Administrator',
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT users_pkey PRIMARY KEY (id),
    CONSTRAINT users_username_key UNIQUE (username)
);

-- Table: public.site_settings
-- Small key/value store for one-off page content, e.g. the About page's
-- "Our journey" photo (key: about_journey_photo, value: /uploads/... path).

CREATE TABLE IF NOT EXISTS public.site_settings
(
    key character varying(80) NOT NULL,
    value text,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT site_settings_pkey PRIMARY KEY (key)
);

-- Table: public.milestones
-- About page "Achievements and milestones" timeline. year_label is free text
-- so it can be a year ("2022") or a word ("Global", "Award").

CREATE TABLE IF NOT EXISTS public.milestones
(
    id serial NOT NULL,
    year_label character varying(40) NOT NULL,
    title character varying(200) NOT NULL,
    description text,
    display_order integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT milestones_pkey PRIMARY KEY (id)
);

-- Table: public.committee_settings
-- Singleton row (id always 1): the Executive Committee's term and election date.

CREATE TABLE IF NOT EXISTS public.committee_settings
(
    id integer NOT NULL DEFAULT 1,
    term_start_year integer NOT NULL,
    term_end_year integer NOT NULL,
    elected_on date,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT committee_settings_pkey PRIMARY KEY (id),
    CONSTRAINT committee_settings_singleton_check CHECK (id = 1),
    CONSTRAINT committee_settings_term_check CHECK (term_end_year >= term_start_year)
);

-- Table: public.committee_members
-- Executive Committee members, shown on the Leadership page in display_order.
-- Unlike SLNA's fixed seats, members can be added and removed freely.

CREATE TABLE IF NOT EXISTS public.committee_members
(
    id serial NOT NULL,
    display_order integer NOT NULL DEFAULT 0,
    role_title character varying(100) NOT NULL,
    name character varying(255) NOT NULL,
    designation character varying(150),
    photo_url character varying(500),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT committee_members_pkey PRIMARY KEY (id)
);

-- Table: public.events
-- Two kinds of event (category):
--   cpd    CPD events (workshops, webinars, conferences, ...). They carry
--          CPD points, an audience, fees and online registration.
--   other  Other events (AGMs, community events, ...): information only.
-- event_type is the finer type within the kind (see lib/events.js).
-- status: cpd       coming_soon | opening_soon | open | closed
--         other     coming_soon | upcoming
-- Past events show as completed whatever the status.
-- Fees (cpd only): fee_type free | paid. When paid, members pay member_fee
-- (member_pricing = same) or the fee for their category, fee_lt / fee_gm /
-- fee_om / fee_pm (member_pricing = by_category); non-members pay
-- non_member_fee (not used when audience = members). A fee of 0 is free.

CREATE TABLE IF NOT EXISTS public.events
(
    id serial NOT NULL,
    title character varying(300) NOT NULL,
    category character varying(20) NOT NULL DEFAULT 'cpd',
    event_type character varying(60) NOT NULL DEFAULT 'Workshop',
    status character varying(20) NOT NULL DEFAULT 'coming_soon',
    event_date date NOT NULL,
    end_date date,
    time_text character varying(100),
    location character varying(300),
    summary text,
    body text,
    cpd_points numeric(5,2),
    audience character varying(20) NOT NULL DEFAULT 'public',
    fee_type character varying(10) NOT NULL DEFAULT 'free',
    member_pricing character varying(20) NOT NULL DEFAULT 'same',
    member_fee numeric(10,2),
    fee_lt numeric(10,2),
    fee_gm numeric(10,2),
    fee_om numeric(10,2),
    fee_pm numeric(10,2),
    non_member_fee numeric(10,2),
    photo_url character varying(500),
    attachment_url character varying(500),
    attachment_name character varying(255),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT events_pkey PRIMARY KEY (id),
    CONSTRAINT events_end_date_check CHECK (end_date IS NULL OR end_date >= event_date),
    CONSTRAINT events_cpd_points_check CHECK (cpd_points IS NULL OR cpd_points >= 0)
);

CREATE INDEX IF NOT EXISTS events_event_date_idx ON public.events (event_date);

-- Nov 2026: CPD events vs other events, with types, statuses, audience and
-- fees. Moves the old categories (cpd / international / community) across.
-- Safe to re-run.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'status') THEN
        ALTER TABLE public.events ADD COLUMN status character varying(20) NOT NULL DEFAULT 'coming_soon';
        -- Past events: registration closed. Upcoming ones wait for the admin to open registration.
        UPDATE public.events SET status = CASE WHEN COALESCE(end_date, event_date) < CURRENT_DATE THEN 'closed' ELSE 'opening_soon' END;
    END IF;
END $$;

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS event_type character varying(60) NOT NULL DEFAULT 'Workshop',
    ADD COLUMN IF NOT EXISTS audience character varying(20) NOT NULL DEFAULT 'public',
    ADD COLUMN IF NOT EXISTS fee_type character varying(10) NOT NULL DEFAULT 'free',
    ADD COLUMN IF NOT EXISTS member_pricing character varying(20) NOT NULL DEFAULT 'same',
    ADD COLUMN IF NOT EXISTS member_fee numeric(10,2),
    ADD COLUMN IF NOT EXISTS fee_lt numeric(10,2),
    ADD COLUMN IF NOT EXISTS fee_gm numeric(10,2),
    ADD COLUMN IF NOT EXISTS fee_om numeric(10,2),
    ADD COLUMN IF NOT EXISTS fee_pm numeric(10,2),
    ADD COLUMN IF NOT EXISTS non_member_fee numeric(10,2),
    ADD COLUMN IF NOT EXISTS attachment_url character varying(500),
    ADD COLUMN IF NOT EXISTS attachment_name character varying(255);

ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_category_check;
UPDATE public.events SET category = 'cpd', event_type = 'International Workshop' WHERE category = 'international';
UPDATE public.events SET category = 'other', event_type = 'Community Event', status = 'upcoming' WHERE category = 'community';
ALTER TABLE public.events ADD CONSTRAINT events_category_check CHECK (category IN ('cpd', 'other'));

ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE public.events ADD CONSTRAINT events_status_check
    CHECK (status IN ('coming_soon', 'opening_soon', 'open', 'closed', 'upcoming'));
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_audience_check;
ALTER TABLE public.events ADD CONSTRAINT events_audience_check CHECK (audience IN ('public', 'members'));

-- How long an event runs, as on the SLNA site: a number of days, months or
-- years from the start date (1 day by default). end_date, when set, is the
-- exact last day and overrides the duration.
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS duration_number integer NOT NULL DEFAULT 1;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS duration_unit character varying(10) NOT NULL DEFAULT 'day';
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_duration_check;
ALTER TABLE public.events ADD CONSTRAINT events_duration_check CHECK (duration_number >= 1 AND duration_unit IN ('day', 'month', 'year'));

-- Time, as on SLNA: a start and end time, or (instead) free text in time_text
-- such as "12 PM EST".
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS start_time time;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS end_time time;

-- How people take part in a CPD event:
--   online   - register on this website (the registration form and fees)
--   external - register on another site (registration_url, e.g. a Google Form)
--   none     - no registration, e.g. an open Zoom meeting (join_url)
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS registration_mode character varying(10) NOT NULL DEFAULT 'online';
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS registration_url character varying(500);
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS join_url character varying(500);
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_registration_mode_check;
ALTER TABLE public.events ADD CONSTRAINT events_registration_mode_check CHECK (registration_mode IN ('online', 'external', 'none'));

-- Foreign participants (CPD events open to everyone): they can attend online
-- and/or physically, each with its own fee in US dollars (NULL on free events).
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS foreign_online boolean NOT NULL DEFAULT false;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS foreign_physical boolean NOT NULL DEFAULT false;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS foreign_fee_online numeric(10,2);
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS foreign_fee_physical numeric(10,2);

-- Seats (CPD events registered on this website), see lib/event-seats.js:
-- seat_limit (null: no limit), seat_hard_stop (close automatically when full),
-- seats_closed (closed by that; the admin reopens it), seat_alerts (80/95/100 %
-- levels already emailed to the secretary).
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS seat_limit integer;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS seat_hard_stop boolean NOT NULL DEFAULT false;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS seats_closed boolean NOT NULL DEFAULT false;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS seat_alerts integer[] NOT NULL DEFAULT '{}';
-- Events saved with an end date before durations existed become a number of days.
UPDATE public.events SET duration_number = (end_date - event_date) + 1, duration_unit = 'day', end_date = NULL
WHERE end_date IS NOT NULL AND end_date > event_date AND duration_number = 1 AND (end_date - event_date) < 366;
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_fee_check;
ALTER TABLE public.events ADD CONSTRAINT events_fee_check CHECK (
    fee_type IN ('free', 'paid') AND member_pricing IN ('same', 'by_category')
    AND COALESCE(member_fee, 0) >= 0 AND COALESCE(fee_lt, 0) >= 0 AND COALESCE(fee_gm, 0) >= 0
    AND COALESCE(fee_om, 0) >= 0 AND COALESCE(fee_pm, 0) >= 0 AND COALESCE(non_member_fee, 0) >= 0);

-- Table: public.news
-- News articles. body is plain text; blank lines separate paragraphs.

CREATE TABLE IF NOT EXISTS public.news
(
    id serial NOT NULL,
    title character varying(300) NOT NULL,
    summary text,
    body text,
    photo_url character varying(500),
    published_at date NOT NULL DEFAULT CURRENT_DATE,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT news_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS news_published_at_idx ON public.news (published_at DESC);

-- Table: public.journals
-- SLICNA journal issues. The PDF (and an optional cover image) are public
-- files in uploads/journals/; the Journal page shows the latest issue as a
-- flipbook and the others as past issues.

CREATE TABLE IF NOT EXISTS public.journals
(
    id serial NOT NULL,
    title character varying(300) NOT NULL,
    issue_label character varying(100),
    published_on date NOT NULL DEFAULT CURRENT_DATE,
    description text,
    pdf_url character varying(500) NOT NULL,
    pdf_name character varying(255),
    pdf_size integer,
    cover_url character varying(500),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT journals_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS journals_published_on_idx ON public.journals (published_on DESC);

-- Table: public.albums / public.album_photos
-- Gallery albums and their photos. Deleting an album deletes its photos.

CREATE TABLE IF NOT EXISTS public.albums
(
    id serial NOT NULL,
    title character varying(200) NOT NULL,
    description text,
    event_date date,
    display_order integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT albums_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.album_photos
(
    id serial NOT NULL,
    album_id integer NOT NULL,
    url character varying(500) NOT NULL,
    caption character varying(300),
    display_order integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT album_photos_pkey PRIMARY KEY (id),
    CONSTRAINT album_photos_album_id_fkey FOREIGN KEY (album_id)
        REFERENCES public.albums (id) ON DELETE CASCADE
);

-- Albums hold videos as well as photos (as on the SLNA site).
ALTER TABLE public.album_photos ADD COLUMN IF NOT EXISTS media_type character varying(10) NOT NULL DEFAULT 'image';
ALTER TABLE public.album_photos DROP CONSTRAINT IF EXISTS album_photos_media_type_check;
ALTER TABLE public.album_photos ADD CONSTRAINT album_photos_media_type_check CHECK (media_type IN ('image', 'video'));

-- A news article's photos and videos are its own album, which also appears
-- in the Gallery. Deleting the album unlinks it; deleting the article keeps the album.
ALTER TABLE public.news ADD COLUMN IF NOT EXISTS album_id integer;
ALTER TABLE public.news DROP CONSTRAINT IF EXISTS news_album_id_fkey;
ALTER TABLE public.news ADD CONSTRAINT news_album_id_fkey FOREIGN KEY (album_id) REFERENCES public.albums (id) ON DELETE SET NULL;

-- Each article has a type, as on the SLNA site (for grouping news later).
-- Keep the list in step with NEWS_TYPES in routes/news.js.
ALTER TABLE public.news ADD COLUMN IF NOT EXISTS news_type character varying(50) NOT NULL DEFAULT 'General News';
ALTER TABLE public.news DROP CONSTRAINT IF EXISTS news_news_type_check;
ALTER TABLE public.news ADD CONSTRAINT news_news_type_check CHECK (news_type IN ('International Nurses Day', 'Annual General Meeting', 'General Meeting', 'CPD Event', 'Community Event', 'Awareness Program', 'Celebration', 'General News'));

-- Table: public.community_sections / public.community_items
-- The Community page is a list of sections, each drawn in one of three styles:
--   feature   - light section with logo, text, bullet points and a photo grid
--   highlight - dark band with one photo beside the text
--   cards     - heading plus a grid of cards (photo, label, title, text)
-- Items are the photos (feature/highlight) or cards (cards) of a section.

CREATE TABLE IF NOT EXISTS public.community_sections
(
    id serial NOT NULL,
    display_order integer NOT NULL DEFAULT 0,
    style character varying(20) NOT NULL DEFAULT 'feature',
    eyebrow character varying(100),
    title character varying(200) NOT NULL,
    body text,
    bullet_points text,
    logo_url character varying(500),
    link_text character varying(100),
    link_url character varying(300),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT community_sections_pkey PRIMARY KEY (id),
    CONSTRAINT community_sections_style_check CHECK (style IN ('feature', 'highlight', 'cards'))
);

CREATE TABLE IF NOT EXISTS public.community_items
(
    id serial NOT NULL,
    section_id integer NOT NULL,
    display_order integer NOT NULL DEFAULT 0,
    image_url character varying(500),
    label character varying(100),
    title character varying(200),
    text text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT community_items_pkey PRIMARY KEY (id),
    CONSTRAINT community_items_section_id_fkey FOREIGN KEY (section_id)
        REFERENCES public.community_sections (id) ON DELETE CASCADE
);

-- ============================================================
-- Membership
-- Categories: LT (Lifetime), GM (General), OM (Ordinary), PM (Partial).
-- LT never expires; the others are valid for 12 months at a time.
-- No recommendation or institution certification is needed for any category.
-- Uploaded documents (photo, payment slip) are
-- PRIVATE: they live in private-uploads/ (later an R2 private bucket) under
-- keys like "membership/applications/<ref>/photo-....jpg", are never served
-- statically, and are only streamed to logged-in admins.
-- ============================================================

-- Table: public.membership_fees
-- One row per category; the amount is editable in the admin panel.

CREATE TABLE IF NOT EXISTS public.membership_fees
(
    category character varying(2) NOT NULL,
    label character varying(60) NOT NULL,
    amount numeric(10,2) NOT NULL,
    is_annual boolean NOT NULL,
    display_order integer NOT NULL DEFAULT 0,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT membership_fees_pkey PRIMARY KEY (category),
    CONSTRAINT membership_fees_category_check CHECK (category IN ('LT', 'GM', 'OM', 'PM')),
    CONSTRAINT membership_fees_amount_check CHECK (amount >= 0)
);

INSERT INTO public.membership_fees (category, label, amount, is_annual, display_order) VALUES
    ('LT', 'Lifetime Membership', 3000, false, 10),
    ('GM', 'General Membership', 1000, true, 20),
    ('OM', 'Ordinary Membership', 500, true, 30),
    ('PM', 'Partial Membership', 1000, true, 40)
ON CONFLICT (category) DO NOTHING;

-- Membership settings live in site_settings (editable in the admin panel).
INSERT INTO public.site_settings (key, value) VALUES
    ('bank_name', 'Bank of Ceylon'),
    ('bank_account_number', '89766252'),
    ('bank_branch', 'Regent Street, Colombo'),
    ('bank_account_name', 'Sri Lanka Intensive Care Nurses Association'),
    ('membership_grace_days', '30'),
    ('membership_notice_days', '30')
ON CONFLICT (key) DO NOTHING;

-- CPD event fees go to a separate account (the Educational Committee's).
INSERT INTO public.site_settings (key, value) VALUES
    ('event_bank_name', 'Bank of Ceylon'),
    ('event_bank_account_number', '90453359'),
    ('event_bank_branch', 'Regent Street, Colombo'),
    ('event_bank_account_name', 'SLICNA Educational Committee')
ON CONFLICT (key) DO NOTHING;

-- Table: public.membership_applications
-- Online applications. status flow:
--   pending -> approved | rejected, with more_info_required (and back to pending) while waiting on the applicant.
-- status_note is shown to the applicant on the status page; admin_notes is internal.

CREATE TABLE IF NOT EXISTS public.membership_applications
(
    id serial NOT NULL,
    reference_number character varying(20) NOT NULL,
    category character varying(2) NOT NULL,
    status character varying(30) NOT NULL DEFAULT 'pending',
    status_note text,
    admin_notes text,

    title character varying(10),
    full_name character varying(255) NOT NULL,
    name_with_initials character varying(255) NOT NULL,
    nic_number character varying(20) NOT NULL,
    date_of_birth date,
    sex character varying(10),
    marital_status character varying(20),
    slnc_number character varying(50),
    slnc_date date,
    slna_number character varying(50),
    slna_date date,
    permanent_address text,
    current_working_place character varying(255),
    official_address text,
    designation character varying(255),
    mobile character varying(30) NOT NULL,
    whatsapp character varying(30),
    residential_phone character varying(30),
    office_phone character varying(30),
    email character varying(255) NOT NULL,
    nursing_school character varying(255),
    batch character varying(50),
    first_appointment_date date,
    first_appointment_place character varying(255),
    icu_training_batch character varying(50),
    icu_training_type character varying(20),
    icu_training_year integer,
    student_number character varying(50),
    institute_registration_date date,
    higher_qualifications text,
    -- Ticked "I don't have my SLNC / SLNA number yet" (the number and date are then empty).
    slnc_not_registered boolean NOT NULL DEFAULT false,
    slna_not_member boolean NOT NULL DEFAULT false,

    photo_key character varying(500),
    receipt_key character varying(500),
    payment_amount numeric(10,2),
    payment_date date,
    declaration_confirmed boolean NOT NULL DEFAULT false,

    reviewed_by integer,
    reviewed_at timestamp with time zone,
    approved_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT membership_applications_pkey PRIMARY KEY (id),
    CONSTRAINT membership_applications_reference_key UNIQUE (reference_number),
    CONSTRAINT membership_applications_category_check CHECK (category IN ('LT', 'GM', 'OM', 'PM')),
    CONSTRAINT membership_applications_status_check CHECK (status IN ('pending', 'more_info_required', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS membership_applications_status_idx ON public.membership_applications (status, created_at DESC);

-- Recommendations (GM/OM) and institution certification (PM) were dropped in
-- Nov 2026; this removes their columns from databases created before that.
ALTER TABLE public.membership_applications
    DROP COLUMN IF EXISTS endorser_name,
    DROP COLUMN IF EXISTS endorser_membership_number,
    DROP COLUMN IF EXISTS endorser_contact,
    DROP COLUMN IF EXISTS endorser_workplace,
    DROP COLUMN IF EXISTS endorser_designation,
    DROP COLUMN IF EXISTS endorsement_key,
    DROP COLUMN IF EXISTS eligibility_basis;

-- The "under review" status was dropped in Nov 2026 (nothing left to review
-- once recommendations went): move such applications back to pending and
-- replace the status check. Safe to re-run.
UPDATE public.membership_applications SET status = 'pending' WHERE status = 'under_review';
ALTER TABLE public.membership_applications DROP CONSTRAINT IF EXISTS membership_applications_status_check;
ALTER TABLE public.membership_applications ADD CONSTRAINT membership_applications_status_check
    CHECK (status IN ('pending', 'more_info_required', 'approved', 'rejected'));

-- Table: public.members
-- Approved members (from an application) and members added by an admin.
-- valid_until is NULL for Lifetime members. is_active = false means an admin
-- deactivated the member; "renewal due / grace / lapsed" are worked out from
-- valid_until and the grace setting, so lapsing happens automatically.

CREATE TABLE IF NOT EXISTS public.members
(
    id serial NOT NULL,
    membership_number character varying(30) NOT NULL,
    category character varying(2) NOT NULL,
    title character varying(10),
    full_name character varying(255) NOT NULL,
    name_with_initials character varying(255) NOT NULL,
    nic_number character varying(20) NOT NULL,
    date_of_birth date,
    sex character varying(10),
    email character varying(255),
    mobile character varying(30),
    whatsapp character varying(30),
    current_working_place character varying(255),
    designation character varying(255),
    joined_on date NOT NULL,
    valid_until date,
    is_active boolean NOT NULL DEFAULT true,
    deactivated_reason text,
    deactivated_at timestamp with time zone,
    photo_key character varying(500),
    application_id integer,
    source character varying(20) NOT NULL DEFAULT 'application',
    admin_notes text,
    id_application_created_at timestamp with time zone,
    id_application_created_by integer,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT members_pkey PRIMARY KEY (id),
    CONSTRAINT members_membership_number_key UNIQUE (membership_number),
    CONSTRAINT members_application_id_key UNIQUE (application_id),
    CONSTRAINT members_application_id_fkey FOREIGN KEY (application_id)
        REFERENCES public.membership_applications (id) ON DELETE SET NULL,
    CONSTRAINT members_category_check CHECK (category IN ('LT', 'GM', 'OM', 'PM')),
    CONSTRAINT members_source_check CHECK (source IN ('application', 'manual')),
    CONSTRAINT members_valid_until_check CHECK ((category = 'LT') = (valid_until IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS members_nic_key ON public.members (upper(nic_number));

-- Legacy members: from the records kept before the website (number, name and
-- dates only). Their NIC and contact details are added later: by an admin, or
-- from their first renewal (a verified renewal copies email / mobile / workplace).
ALTER TABLE public.members ALTER COLUMN nic_number DROP NOT NULL;
ALTER TABLE public.members DROP CONSTRAINT IF EXISTS members_source_check;
ALTER TABLE public.members ADD CONSTRAINT members_source_check CHECK (source IN ('application', 'manual', 'legacy'));

-- Who confirmed the ID card application (added Nov 2026).
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS id_application_created_by integer;

-- Table: public.renewal_requests
-- Renewals and upgrades (e.g. GM -> LT) submitted by members through their
-- renewal link, plus payments an admin records directly (recorded_by_admin).
-- Contact details the member corrected are applied when it is verified.

CREATE TABLE IF NOT EXISTS public.renewal_requests
(
    id serial NOT NULL,
    member_id integer NOT NULL,
    kind character varying(10) NOT NULL DEFAULT 'renewal',
    from_category character varying(2) NOT NULL,
    to_category character varying(2) NOT NULL,
    amount numeric(10,2) NOT NULL,
    payment_reference character varying(60) NOT NULL,
    payment_date date,
    receipt_key character varying(500),
    status character varying(20) NOT NULL DEFAULT 'pending',
    status_note text,
    email character varying(255),
    mobile character varying(30),
    current_working_place character varying(255),
    previous_valid_until date,
    new_valid_until date,
    recorded_by_admin boolean NOT NULL DEFAULT false,
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT renewal_requests_pkey PRIMARY KEY (id),
    CONSTRAINT renewal_requests_member_id_fkey FOREIGN KEY (member_id)
        REFERENCES public.members (id) ON DELETE CASCADE,
    CONSTRAINT renewal_requests_kind_check CHECK (kind IN ('renewal', 'upgrade')),
    CONSTRAINT renewal_requests_status_check CHECK (status IN ('pending', 'verified', 'rejected'))
);

CREATE INDEX IF NOT EXISTS renewal_requests_status_idx ON public.renewal_requests (status, created_at DESC);

-- Nov 2026: an upgrade to Lifetime asks for the same PBCN ICU training details
-- as a Lifetime application.
ALTER TABLE public.renewal_requests
    ADD COLUMN IF NOT EXISTS icu_training_batch character varying(50),
    ADD COLUMN IF NOT EXISTS icu_training_type character varying(20),
    ADD COLUMN IF NOT EXISTS icu_training_year integer;

-- Table: public.renewal_tokens
-- Personal renewal links. Only a SHA-256 hash of the token is stored.

CREATE TABLE IF NOT EXISTS public.renewal_tokens
(
    id serial NOT NULL,
    member_id integer NOT NULL,
    token_hash character(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT renewal_tokens_pkey PRIMARY KEY (id),
    CONSTRAINT renewal_tokens_token_hash_key UNIQUE (token_hash),
    CONSTRAINT renewal_tokens_member_id_fkey FOREIGN KEY (member_id)
        REFERENCES public.members (id) ON DELETE CASCADE
);

-- via_lookup: made by the "Renew membership" page from a membership number
-- alone (no NIC, since older members have none on record). Anyone could type
-- a number, so these don't show the member's contact details.
ALTER TABLE public.renewal_tokens
    ADD COLUMN IF NOT EXISTS via_lookup boolean NOT NULL DEFAULT false;

-- Table: public.reminder_log
-- Every renewal reminder the daily job tried to send. A reminder kind is sent
-- once per membership period (period_key = valid_until at the time).

CREATE TABLE IF NOT EXISTS public.reminder_log
(
    id serial NOT NULL,
    member_id integer NOT NULL,
    kind character varying(30) NOT NULL,
    period_key date NOT NULL,
    status character varying(10) NOT NULL,
    detail text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT reminder_log_pkey PRIMARY KEY (id),
    CONSTRAINT reminder_log_member_id_fkey FOREIGN KEY (member_id)
        REFERENCES public.members (id) ON DELETE CASCADE,
    CONSTRAINT reminder_log_status_check CHECK (status IN ('sent', 'skipped', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS reminder_log_sent_once ON public.reminder_log (member_id, kind, period_key) WHERE status = 'sent';

-- Table: public.event_registrations
-- Online registrations for CPD events. Members are verified against the
-- members table (membership number + NIC) and pay the fee for their
-- category; fee_category is LT / GM / OM / PM, NM (non-member), or FO / FP
-- (foreign participant attending online / physically) and amount_due is the
-- fee at the time of registering, in currency (LKR, or USD for foreign
-- participants, who give a passport number in nic_number and their country). event_title and
-- event_date are kept so the record still reads well if the event is
-- edited. Receipts are private files (private-uploads/events/...).
-- status: pending -> confirmed | rejected (status_note = reason).

CREATE TABLE IF NOT EXISTS public.event_registrations
(
    id serial NOT NULL,
    reference_number character varying(20) NOT NULL,
    event_id integer NOT NULL,
    event_title character varying(300) NOT NULL,
    event_date date NOT NULL,
    registrant_type character varying(20) NOT NULL,
    member_id integer,
    membership_number character varying(30),
    fee_category character varying(2) NOT NULL,
    amount_due numeric(10,2) NOT NULL DEFAULT 0,
    full_name character varying(255) NOT NULL,
    certificate_name character varying(255) NOT NULL,
    nic_number character varying(20) NOT NULL,
    slnc_number character varying(50),
    email character varying(255) NOT NULL,
    mobile character varying(30) NOT NULL,
    postal_address text NOT NULL,
    workplace character varying(255) NOT NULL,
    workplace_address text NOT NULL,
    pay_by character varying(20),
    payment_date date,
    receipt_key character varying(500),
    status character varying(20) NOT NULL DEFAULT 'pending',
    status_note text,
    admin_notes text,
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT event_registrations_pkey PRIMARY KEY (id),
    CONSTRAINT event_registrations_reference_key UNIQUE (reference_number),
    CONSTRAINT event_registrations_event_fkey FOREIGN KEY (event_id)
        REFERENCES public.events (id) ON DELETE RESTRICT,
    CONSTRAINT event_registrations_member_fkey FOREIGN KEY (member_id)
        REFERENCES public.members (id) ON DELETE SET NULL,
    CONSTRAINT event_registrations_type_check CHECK (registrant_type IN ('member', 'non_member')),
    CONSTRAINT event_registrations_fee_category_check CHECK (fee_category IN ('LT', 'GM', 'OM', 'PM', 'NM')),
    CONSTRAINT event_registrations_pay_by_check CHECK (pay_by IS NULL OR pay_by IN ('individual', 'organisation')),
    CONSTRAINT event_registrations_status_check CHECK (status IN ('pending', 'confirmed', 'rejected'))
);

ALTER TABLE public.event_registrations ADD COLUMN IF NOT EXISTS currency character varying(3) NOT NULL DEFAULT 'LKR';
ALTER TABLE public.event_registrations ADD COLUMN IF NOT EXISTS country character varying(100);
ALTER TABLE public.event_registrations DROP CONSTRAINT IF EXISTS event_registrations_type_check;
ALTER TABLE public.event_registrations ADD CONSTRAINT event_registrations_type_check CHECK (registrant_type IN ('member', 'non_member', 'foreign'));
ALTER TABLE public.event_registrations DROP CONSTRAINT IF EXISTS event_registrations_fee_category_check;
ALTER TABLE public.event_registrations ADD CONSTRAINT event_registrations_fee_category_check CHECK (fee_category IN ('LT', 'GM', 'OM', 'PM', 'NM', 'FO', 'FP'));

CREATE INDEX IF NOT EXISTS event_registrations_event_idx ON public.event_registrations (event_id, status);
-- One live registration per person per event (a rejected one can be redone).
CREATE UNIQUE INDEX IF NOT EXISTS event_registrations_once ON public.event_registrations (event_id, upper(nic_number)) WHERE status <> 'rejected';

-- Table: public.retired_membership_numbers
-- Numbers a member gave up (e.g. their GM number when upgrading to Lifetime).
-- They are never suggested or assigned again, so old ID cards, letters and
-- records stay unambiguous. The upgrade request also keeps the number in
-- renewal_requests.previous_membership_number.

CREATE TABLE IF NOT EXISTS public.retired_membership_numbers
(
    id serial NOT NULL,
    membership_number character varying(30) NOT NULL,
    member_id integer,
    reason character varying(30) NOT NULL DEFAULT 'upgrade',
    retired_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT retired_membership_numbers_pkey PRIMARY KEY (id),
    CONSTRAINT retired_membership_numbers_member_fkey FOREIGN KEY (member_id)
        REFERENCES public.members (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS retired_membership_numbers_key
    ON public.retired_membership_numbers (regexp_replace(upper(membership_number), '[^A-Z0-9]', '', 'g'));

ALTER TABLE public.renewal_requests ADD COLUMN IF NOT EXISTS previous_membership_number character varying(30);

-- Upgrades verified before this table existed: the old number is recovered
-- from the payment reference of online renewals ("GM000226-2611" -> "GM 0002/26").
INSERT INTO public.retired_membership_numbers (membership_number, member_id, reason, retired_at)
SELECT regexp_replace(r.payment_reference, '^([A-Z]{2})(\d{4})(\d{2})-\d{4}$', '\1 \2/\3'), r.member_id, 'upgrade', COALESCE(r.reviewed_at, r.created_at)
FROM public.renewal_requests r
WHERE r.kind = 'upgrade' AND r.status = 'verified' AND NOT r.recorded_by_admin
  AND r.payment_reference ~ '^[A-Z]{2}\d{6}-\d{4}$'
ON CONFLICT DO NOTHING;

UPDATE public.renewal_requests r
SET previous_membership_number = regexp_replace(r.payment_reference, '^([A-Z]{2})(\d{4})(\d{2})-\d{4}$', '\1 \2/\3')
WHERE r.kind = 'upgrade' AND r.status = 'verified' AND NOT r.recorded_by_admin
  AND r.previous_membership_number IS NULL AND r.payment_reference ~ '^[A-Z]{2}\d{6}-\d{4}$';
