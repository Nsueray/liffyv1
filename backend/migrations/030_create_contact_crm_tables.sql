-- 030_create_contact_crm_tables.sql
-- Contact-level CRM: notes, activities, tasks
-- All tables scoped by organizer_id for multi-tenant isolation.

-- Contact Notes — free-form notes written by users on a contact
CREATE TABLE IF NOT EXISTS contact_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_notes_person ON contact_notes(person_id);
CREATE INDEX IF NOT EXISTS idx_contact_notes_organizer ON contact_notes(organizer_id);

-- Contact Activities — auto-generated timeline (notes, emails, replies, tasks, zoho, calls, meetings)
-- activity_type values: note_added, email_sent, email_replied, email_opened,
--                        call, meeting, status_change, zoho_pushed, task_created, task_completed
CREATE TABLE IF NOT EXISTS contact_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  activity_type VARCHAR(30) NOT NULL,
  description TEXT,
  meta JSONB,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_activities_person ON contact_activities(person_id);
CREATE INDEX IF NOT EXISTS idx_contact_activities_organizer ON contact_activities(organizer_id);
CREATE INDEX IF NOT EXISTS idx_contact_activities_type ON contact_activities(activity_type);

-- Contact Tasks — follow-up work items
CREATE TABLE IF NOT EXISTS contact_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  due_date DATE,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  priority VARCHAR(10) DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_tasks_person ON contact_tasks(person_id);
CREATE INDEX IF NOT EXISTS idx_contact_tasks_organizer ON contact_tasks(organizer_id);
CREATE INDEX IF NOT EXISTS idx_contact_tasks_assigned ON contact_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_contact_tasks_due ON contact_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_contact_tasks_status ON contact_tasks(status);
