-- 004_create_organizers_users_sender_identities.sql

-- ORGANIZERS
-- Her firma / account buraya kaydolacak (örn. Elan Expo)
CREATE TABLE organizers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,             -- Elan Expo
    slug VARCHAR(100) UNIQUE,               -- "elan-expo"
    logo_url TEXT,
    phone VARCHAR(50),
    country VARCHAR(100),
    timezone VARCHAR(100),                  -- e.g. "Europe/Istanbul"
    sendgrid_api_key TEXT NOT NULL,         -- her organizer kendi SendGrid hesabını kullanacak
    default_from_email VARCHAR(255),        -- varsayılan gönderici (örn. noreply@liffy.app)
    default_from_name VARCHAR(255),         -- "Elan Expo Team"
    created_at TIMESTAMP DEFAULT NOW()
);

-- USERS
-- Organizer içindeki kullanıcılar (sen, Elif vs. login olacak kişiler)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,            -- login e-mail (örn. elif@elan-expo.com)
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user',  -- 'owner', 'admin', 'user'
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE INDEX idx_users_organizer_id ON users(organizer_id);

-- SENDER IDENTITIES
-- Her kullanıcı / organizer için birden fazla "From" adresi:
-- Örnekler:
--   Elif - ElanExpo      → from_email = "elif@elan-expo.com"
--   Elif - SiemaExpo     → from_email = "elif@siemaexpo.com"
--   Elif - MegaClima     → from_email = "elif@megaclimaexpo.com"
CREATE TABLE sender_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    label VARCHAR(100),                     -- "Elif - SiemaExpo"
    from_name VARCHAR(255) NOT NULL,        -- "Elif from SiemaExpo"
    from_email VARCHAR(255) NOT NULL,       -- örn. "elif@siemaexpo.com"
    reply_to VARCHAR(255),
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sender_identities_org ON sender_identities(organizer_id);
CREATE INDEX idx_sender_identities_user ON sender_identities(user_id);
