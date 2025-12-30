-- 006_create_prospects_and_lists.sql

-- PROSPECTS
-- Individual contacts/email addresses discovered via data mining, imports, etc.
CREATE TABLE prospects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    email VARCHAR(320) NOT NULL,
    name VARCHAR(255),
    company VARCHAR(255),
    country VARCHAR(100),
    sector VARCHAR(100),
    source_type VARCHAR(20),                -- url, pdf, import, manual, api, etc.
    source_ref TEXT,                        -- URL, file name, note, etc.
    verification_status VARCHAR(20) DEFAULT 'unknown', -- unknown, valid, invalid, catchall, risky
    meta JSONB,                             -- any extra data (job title, phone, etc.)
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_prospects_organizer_id ON prospects(organizer_id);
CREATE INDEX idx_prospects_email ON prospects(email);
CREATE INDEX idx_prospects_verification_status ON prospects(verification_status);

-- LISTS
-- Named lists / segments (e.g. "HVAC – Siema 2026", "MegaClima Nigeria VIPs")
CREATE TABLE lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type VARCHAR(20),                       -- mined, import, manual, mix
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_lists_organizer_id ON lists(organizer_id);

-- LIST MEMBERS
-- Many-to-many relationship between lists and prospects
CREATE TABLE list_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT list_members_unique UNIQUE (list_id, prospect_id)
);

CREATE INDEX idx_list_members_list_id ON list_members(list_id);
CREATE INDEX idx_list_members_organizer_id ON list_members(organizer_id);
