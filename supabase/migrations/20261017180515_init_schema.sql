--------------------------------------------------------------------------------
-- STUDYMEET SUPABASE SQL SCHEMA — v2.1 (corrected)
-- Fixes applied vs the prototype: see chat for the full list. Highlights:
--   - app_settings had RLS on with no SELECT policy -> blocked session
--     creation and chat inserts entirely. Fixed.
--   - join_session() clobbered its own suspension check (INTO the same
--     variable twice) -> rejected every non-suspended user. Fixed.
--   - session_members / messages had no SELECT policies -> "my sessions",
--     chat, host-control visibility all returned empty. Fixed.
--   - No cancellation-protection trigger, no session_members DELETE policy,
--     no spots_remaining restore on leave, no overlap/total-cap check on
--     session creation, no admin concept, no suspension_appeals/audit_log
--     tables. All added.
--------------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

--------------------------------------------------------------------------------
-- 1. ENUMS & CUSTOM TYPES
--------------------------------------------------------------------------------
CREATE TYPE user_gender AS ENUM ('Male', 'Female', 'Prefer not to say');
-- Restored per confirmation: UTM's booking system doesn't support rooms
-- outside this set, so this is a genuine business constraint, not just a
-- UI dropdown. Double-check these exact labels (and the "Maanjiwe
-- nendamowinan" spacing) against UTM's actual booking portal before
-- seeding/launch — a mismatch here is a migration, not a config change.
CREATE TYPE utm_booking_building AS ENUM (
    'Library',
    'Instructional Building',
    'Deerfield Hall',
    'Maanjiwe nendamowinan'
);
CREATE TYPE session_gender_pref AS ENUM ('open_to_all', 'women_only', 'men_only');
CREATE TYPE session_status AS ENUM ('upcoming', 'full', 'ongoing', 'completed', 'cancelled');
CREATE TYPE member_status AS ENUM ('Accepted');
CREATE TYPE report_category AS ENUM ('no_show', 'inappropriate_behavior', 'host_abuse');
CREATE TYPE report_status AS ENUM ('pending', 'verified', 'dismissed');
CREATE TYPE suspension_severity AS ENUM ('standard', 'severe');
CREATE TYPE suspension_status AS ENUM ('active', 'expired', 'overturned');
CREATE TYPE appeal_status AS ENUM ('pending', 'granted', 'denied');
CREATE TYPE notification_status AS ENUM ('pending', 'sent', 'failed');

--------------------------------------------------------------------------------
-- 2. SYSTEM SETTINGS TABLE (single-row configuration)
--------------------------------------------------------------------------------
CREATE TABLE app_settings (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    n_host_cap INT NOT NULL DEFAULT 2,
    n_total_cap INT NOT NULL DEFAULT 4,
    chat_grace_period_days INT NOT NULL DEFAULT 3,
    suspension_duration_days_default INT NOT NULL DEFAULT 7,
    appeal_cooldown_days_default INT NOT NULL DEFAULT 14,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_settings (id, n_host_cap, n_total_cap, chat_grace_period_days, suspension_duration_days_default, appeal_cooldown_days_default)
VALUES (1, 2, 4, 3, 7, 14)
ON CONFLICT (id) DO NOTHING;

--------------------------------------------------------------------------------
-- 3. USERS TABLE & AUTH TRIGGER
--------------------------------------------------------------------------------
CREATE TABLE users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    first_name TEXT NOT NULL CHECK (BTRIM(first_name) <> ''),
    last_name TEXT NOT NULL CHECK (BTRIM(last_name) <> ''),
    gender user_gender NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
    suspended_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_utm_email CHECK (email ~* '^[A-Za-z0-9._%+-]+@mail\.utoronto\.ca$')
);

-- is_admin is provisioned manually (`UPDATE users SET is_admin = true WHERE
-- id = '...'`) per the roadmap's Phase 9 scope ("assume you're the only
-- admin, provisioned manually") — no signup-time admin path on purpose.

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    user_email TEXT;
    user_first_name TEXT;
    user_last_name TEXT;
BEGIN
    user_email := NEW.email;
    user_first_name := NULLIF(BTRIM(NEW.raw_user_meta_data->>'first_name'), '');
    user_last_name := NULLIF(BTRIM(NEW.raw_user_meta_data->>'last_name'), '');

    IF user_email !~* '^[A-Za-z0-9._%+-]+@mail\.utoronto\.ca$' THEN
        RAISE EXCEPTION 'Access restricted to @mail.utoronto.ca email addresses only.';
    END IF;

    IF user_first_name IS NULL OR user_last_name IS NULL THEN
        RAISE EXCEPTION 'First name and last name are required.';
    END IF;

    INSERT INTO public.users (id, email, first_name, last_name, gender)
    VALUES (
        NEW.id,
        user_email,
        user_first_name,
        user_last_name,
        COALESCE((NEW.raw_user_meta_data->>'gender')::user_gender, 'Prefer not to say')
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

--------------------------------------------------------------------------------
-- 4. COURSES & USER ENROLLMENTS
--------------------------------------------------------------------------------
CREATE TABLE courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_code TEXT NOT NULL UNIQUE,
    course_title TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_courses (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, course_id)
);

CREATE OR REPLACE FUNCTION check_max_courses_limit()
RETURNS TRIGGER AS $$
DECLARE
    course_count INT;
BEGIN
    SELECT COUNT(*) INTO course_count FROM user_courses WHERE user_id = NEW.user_id;
    IF course_count >= 6 THEN
        RAISE EXCEPTION 'A student may have a maximum of 6 enrolled courses at any time.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_max_courses
    BEFORE INSERT ON user_courses
    FOR EACH ROW EXECUTE FUNCTION check_max_courses_limit();

-- Dropping a course removes the user from any ACTIVE session for that
-- course (fixed: original also stripped completed-session history).
CREATE OR REPLACE FUNCTION handle_course_unenrollment()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM session_members sm
    USING study_sessions s
    WHERE sm.session_id = s.id
      AND sm.user_id = OLD.user_id
      AND s.course_id = OLD.course_id
      AND s.status IN ('upcoming', 'full', 'ongoing');
    RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_user_course_deleted
    AFTER DELETE ON user_courses
    FOR EACH ROW EXECUTE FUNCTION handle_course_unenrollment();

--------------------------------------------------------------------------------
-- 5. STUDY SESSIONS & MEMBERSHIPS
--------------------------------------------------------------------------------
CREATE TABLE study_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    location TEXT NOT NULL,
    utm_booking_included BOOLEAN NOT NULL DEFAULT FALSE,
    booking_name TEXT,
    booking_room TEXT,
    booking_building utm_booking_building,
    -- Floor is 2: a spots_total of 1 means a session only the host could
    -- ever occupy, which isn't a joinable study session.
    spots_total INT NOT NULL CHECK (spots_total BETWEEN 2 AND 6),
    -- Ceiling stays 5 regardless of the floor above: auto_add_host_to_members()
    -- always deducts the host's own spot on creation (spots_remaining =
    -- spots_total - 1), so remaining can never reach spots_total itself.
    spots_remaining INT NOT NULL CHECK (spots_remaining BETWEEN 0 AND 5),
    gender_preference session_gender_pref NOT NULL DEFAULT 'open_to_all',
    note TEXT CHECK (length(note) <= 200),
    status session_status NOT NULL DEFAULT 'upcoming',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_session_time CHECK (ends_at > starts_at)
);

CREATE INDEX idx_sessions_host ON study_sessions(host_id);
CREATE INDEX idx_sessions_course ON study_sessions(course_id);
CREATE INDEX idx_sessions_status_starts ON study_sessions(status, starts_at);

CREATE TABLE session_members (
    session_id UUID REFERENCES study_sessions(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    status member_status NOT NULL DEFAULT 'Accepted',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, user_id)
);

CREATE OR REPLACE FUNCTION check_session_starts_in_future()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.starts_at <= NOW() THEN
        RAISE EXCEPTION 'Session start time must be strictly in the future.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_session_future
    BEFORE INSERT OR UPDATE OF starts_at ON study_sessions
    FOR EACH ROW EXECUTE FUNCTION check_session_starts_in_future();

CREATE OR REPLACE FUNCTION check_booking_fields_required()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.utm_booking_included THEN
        IF TRIM(COALESCE(NEW.booking_name, '')) = ''
           OR TRIM(COALESCE(NEW.booking_room, '')) = ''
           OR NEW.booking_building IS NULL THEN
            RAISE EXCEPTION 'Booking name, exact room, and building are required when UTM booking is included.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_room_booking_fields
    BEFORE INSERT OR UPDATE ON study_sessions
    FOR EACH ROW EXECUTE FUNCTION check_booking_fields_required();

CREATE OR REPLACE FUNCTION check_course_enrollment()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM user_courses WHERE user_id = NEW.host_id AND course_id = NEW.course_id
    ) THEN
        RAISE EXCEPTION 'A session may only be created for a course the host is currently enrolled in.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_host_course_enrollment
    BEFORE INSERT ON study_sessions
    FOR EACH ROW EXECUTE FUNCTION check_course_enrollment();

CREATE OR REPLACE FUNCTION enforce_host_cap_limit()
RETURNS TRIGGER AS $$
DECLARE
    v_host_cap INT;
    v_active_hosted INT;
BEGIN
    SELECT n_host_cap INTO v_host_cap FROM app_settings WHERE id = 1;
    SELECT COUNT(*) INTO v_active_hosted
    FROM study_sessions
    WHERE host_id = NEW.host_id AND status IN ('upcoming', 'full', 'ongoing');

    IF v_active_hosted >= v_host_cap THEN
        RAISE EXCEPTION 'User has reached the maximum allowed host sessions cap.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER enforce_host_cap_trigger
    BEFORE INSERT ON study_sessions
    FOR EACH ROW EXECUTE FUNCTION enforce_host_cap_limit();

-- NEW: creation never checked SESSION-OVERLAP or the total-session cap
-- (SESSION-CAP-2) — only join_session() did. A session you host also
-- counts toward your own total, so this needs checking at creation too.
CREATE OR REPLACE FUNCTION enforce_create_session_constraints()
RETURNS TRIGGER AS $$
DECLARE
    v_overlap_exists BOOLEAN;
    v_total_active INT;
    v_max_total INT;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM session_members sm
        JOIN study_sessions s ON sm.session_id = s.id
        WHERE sm.user_id = NEW.host_id
          AND s.status IN ('upcoming', 'full', 'ongoing')
          AND NEW.starts_at < s.ends_at
          AND NEW.ends_at > s.starts_at
    ) INTO v_overlap_exists;

    IF v_overlap_exists THEN
        RAISE EXCEPTION 'Schedule conflict: overlaps with an existing active session.';
    END IF;

    SELECT n_total_cap INTO v_max_total FROM app_settings WHERE id = 1;
    SELECT COUNT(*) INTO v_total_active
    FROM session_members sm
    JOIN study_sessions s ON sm.session_id = s.id
    WHERE sm.user_id = NEW.host_id AND s.status IN ('upcoming', 'full', 'ongoing');

    IF v_total_active >= v_max_total THEN
        RAISE EXCEPTION 'User has reached the maximum allowed total active sessions cap.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER enforce_create_session_constraints_trigger
    BEFORE INSERT ON study_sessions
    FOR EACH ROW EXECUTE FUNCTION enforce_create_session_constraints();

CREATE OR REPLACE FUNCTION auto_add_host_to_members()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO session_members (session_id, user_id, status)
    VALUES (NEW.id, NEW.host_id, 'Accepted')
    ON CONFLICT DO NOTHING;

    UPDATE study_sessions SET spots_remaining = NEW.spots_total - 1 WHERE id = NEW.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_session_created_add_host
    AFTER INSERT ON study_sessions
    FOR EACH ROW EXECUTE FUNCTION auto_add_host_to_members();

-- NEW: cancellation protection (§3.5.3) — was entirely missing. Needed
-- alongside the sessions_update_policy below (hosts can UPDATE their own
-- session; this trigger is what actually blocks the cancel-with-2+-members
-- case regardless of what the app layer sends).
CREATE OR REPLACE FUNCTION enforce_cancellation_protection()
RETURNS TRIGGER AS $$
DECLARE
    v_member_count INT;
BEGIN
    IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
        SELECT COUNT(*) INTO v_member_count FROM session_members WHERE session_id = OLD.id;
        IF v_member_count > 1 THEN
            RAISE EXCEPTION 'Cannot cancel directly once other members have joined — leave the session instead.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_cancellation_protection_trigger
    BEFORE UPDATE OF status ON study_sessions
    FOR EACH ROW EXECUTE FUNCTION enforce_cancellation_protection();

--------------------------------------------------------------------------------
-- 6. ATOMIC JOIN RPC
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION join_session(p_session_id UUID)
RETURNS VOID AS $$
DECLARE
    v_user_id UUID;
    v_session study_sessions%ROWTYPE;
    v_user_gender user_gender;
    v_is_suspended BOOLEAN;
    v_suspended_until TIMESTAMPTZ;
    v_total_active INT;
    v_max_total INT;
    v_is_enrolled BOOLEAN;
    v_overlap_exists BOOLEAN;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    -- FIXED: prototype selected two columns into the same variable,
    -- clobbering is_suspended and rejecting every non-suspended user.
    SELECT is_suspended, suspended_until, gender
    INTO v_is_suspended, v_suspended_until, v_user_gender
    FROM users WHERE id = v_user_id;

    IF v_is_suspended AND (v_suspended_until IS NULL OR v_suspended_until > NOW()) THEN
        RAISE EXCEPTION 'Account is suspended or banned.';
    END IF;

    SELECT * INTO v_session FROM study_sessions WHERE id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Session not found.';
    END IF;

    IF v_session.status NOT IN ('upcoming', 'full') OR v_session.starts_at <= NOW() THEN
        RAISE EXCEPTION 'Session is not active or has already started.';
    END IF;

    IF v_session.spots_remaining <= 0 THEN
        RAISE EXCEPTION 'Session is full.';
    END IF;

    IF EXISTS (SELECT 1 FROM session_members WHERE session_id = p_session_id AND user_id = v_user_id) THEN
        RAISE EXCEPTION 'User is already a member of this session.';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM user_courses WHERE user_id = v_user_id AND course_id = v_session.course_id
    ) INTO v_is_enrolled;

    IF NOT v_is_enrolled THEN
        RAISE EXCEPTION 'User is not enrolled in this session''s course.';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM session_members sm
        JOIN study_sessions s ON sm.session_id = s.id
        WHERE sm.user_id = v_user_id
          AND s.status IN ('upcoming', 'full', 'ongoing')
          AND v_session.starts_at < s.ends_at
          AND v_session.ends_at > s.starts_at
    ) INTO v_overlap_exists;

    IF v_overlap_exists THEN
        RAISE EXCEPTION 'Schedule conflict: overlaps with an existing active session.';
    END IF;

    SELECT n_total_cap INTO v_max_total FROM app_settings WHERE id = 1;
    SELECT COUNT(*) INTO v_total_active
    FROM session_members sm
    JOIN study_sessions s ON sm.session_id = s.id
    WHERE sm.user_id = v_user_id AND s.status IN ('upcoming', 'full', 'ongoing');

    IF v_total_active >= v_max_total THEN
        RAISE EXCEPTION 'User has reached the maximum allowed total active sessions cap.';
    END IF;

    IF v_session.gender_preference = 'women_only' AND v_user_gender <> 'Female' THEN
        RAISE EXCEPTION 'This session is restricted to women only.';
    ELSIF v_session.gender_preference = 'men_only' AND v_user_gender <> 'Male' THEN
        RAISE EXCEPTION 'This session is restricted to men only.';
    END IF;

    INSERT INTO session_members (session_id, user_id, status)
    VALUES (p_session_id, v_user_id, 'Accepted');

    UPDATE study_sessions
    SET spots_remaining = spots_remaining - 1,
        status = CASE WHEN (spots_remaining - 1) = 0 THEN 'full'::session_status ELSE status END
    WHERE id = p_session_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

--------------------------------------------------------------------------------
-- 7. MEMBER DEPARTURE — spot restoration + host succession (combined)
--------------------------------------------------------------------------------
CREATE TABLE outbound_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id UUID REFERENCES study_sessions(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL UNIQUE,
    status notification_status NOT NULL DEFAULT 'pending',
    attempt_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Combined into one AFTER DELETE trigger (was two separate concerns, one
-- of which — restoring spots_remaining / reverting 'full' -> 'upcoming' —
-- was missing entirely in the prototype). Fires identically whether the
-- departure came from a manual leave, a host-initiated removal, course
-- unenrollment, or a suspension cascade, since all of those go through a
-- DELETE on session_members.
CREATE OR REPLACE FUNCTION handle_session_member_departure()
RETURNS TRIGGER AS $$
DECLARE
    v_session study_sessions%ROWTYPE;
    v_next_host UUID;
    v_remaining_count INT;
BEGIN
    SELECT * INTO v_session FROM study_sessions WHERE id = OLD.session_id;
    IF NOT FOUND THEN
        RETURN OLD; -- session already gone (e.g. a prior row in this same cascade deleted it)
    END IF;

    -- Restore the freed spot and un-Full the session if needed.
    UPDATE study_sessions
    SET spots_remaining = LEAST(spots_remaining + 1, spots_total),
        status = CASE WHEN status = 'full' THEN 'upcoming' ELSE status END
    WHERE id = OLD.session_id;

    IF v_session.host_id = OLD.user_id THEN
        SELECT COUNT(*) INTO v_remaining_count FROM session_members WHERE session_id = OLD.session_id;

        IF v_remaining_count > 0 THEN
            SELECT user_id INTO v_next_host
            FROM session_members
            WHERE session_id = OLD.session_id
            ORDER BY joined_at ASC
            LIMIT 1;

            UPDATE study_sessions SET host_id = v_next_host WHERE id = OLD.session_id;

            INSERT INTO outbound_notifications (event_type, recipient_user_id, session_id, idempotency_key)
            VALUES ('HOST_TRANSFER', v_next_host, OLD.session_id, gen_random_uuid()::text);
        ELSE
            DELETE FROM study_sessions WHERE id = OLD.session_id;
        END IF;
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_member_departed
    AFTER DELETE ON session_members
    FOR EACH ROW EXECUTE FUNCTION handle_session_member_departure();

--------------------------------------------------------------------------------
-- 8. TRUST, SAFETY & NOTIFICATIONS
--------------------------------------------------------------------------------
CREATE TABLE reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id UUID REFERENCES study_sessions(id) ON DELETE SET NULL,
    category report_category NOT NULL,
    description TEXT CHECK (length(description) <= 300),
    status report_status NOT NULL DEFAULT 'pending',
    admin_reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
    internal_note TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT no_self_report CHECK (reporter_id <> reported_user_id)
);

CREATE TABLE warnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
    report_id UUID REFERENCES reports(id) ON DELETE SET NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE suspensions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
    severity suspension_severity NOT NULL DEFAULT 'standard',
    reason TEXT NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMPTZ, -- NULL = permanent ban
    status suspension_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NEW: required by §5.2/§3.9.5, was entirely missing from the prototype.
CREATE TABLE suspension_appeals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    suspension_id UUID NOT NULL REFERENCES suspensions(id) ON DELETE CASCADE,
    appeal_text TEXT NOT NULL CHECK (length(appeal_text) <= 300),
    status appeal_status NOT NULL DEFAULT 'pending',
    resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DB-level enforcement of "only one open appeal per suspension" (§3.9.5),
-- rather than relying on the app layer to check before inserting.
CREATE UNIQUE INDEX one_pending_appeal_per_suspension
    ON suspension_appeals (suspension_id) WHERE status = 'pending';

-- NEW: required by §3.8.3/§5.2, was entirely missing from the prototype.
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL, -- nullable: system-triggered actions
    action_type TEXT NOT NULL,
    session_id UUID REFERENCES study_sessions(id) ON DELETE SET NULL,
    target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Suspension sync: scoped to ACTIVE sessions only (fixed — prototype wiped
-- membership rows from completed sessions too, destroying history). Each
-- row deleted here fires handle_session_member_departure() above, so spot
-- restoration + host succession happen automatically, per session.
CREATE OR REPLACE FUNCTION handle_new_suspension()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE users SET is_suspended = TRUE, suspended_until = NEW.ends_at WHERE id = NEW.user_id;

    DELETE FROM session_members sm
    USING study_sessions s
    WHERE sm.session_id = s.id
      AND sm.user_id = NEW.user_id
      AND s.status IN ('upcoming', 'full', 'ongoing');

    INSERT INTO audit_log (actor_id, action_type, target_user_id, details)
    VALUES (NEW.admin_id, 'suspension_issued', NEW.user_id, jsonb_build_object('suspension_id', NEW.id, 'severity', NEW.severity));

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_suspension_created
    AFTER INSERT ON suspensions
    FOR EACH ROW EXECUTE FUNCTION handle_new_suspension();

-- Appeal grant clears the lockout immediately (§3.9.5).
CREATE OR REPLACE FUNCTION handle_appeal_resolution()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'granted' AND OLD.status = 'pending' THEN
        UPDATE users SET is_suspended = FALSE, suspended_until = NULL
        WHERE id = NEW.user_id;

        UPDATE suspensions SET status = 'overturned' WHERE id = NEW.suspension_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_appeal_resolved
    AFTER UPDATE OF status ON suspension_appeals
    FOR EACH ROW EXECUTE FUNCTION handle_appeal_resolution();

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL CHECK (length(content) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);

--------------------------------------------------------------------------------
-- 9. ROW LEVEL SECURITY
--------------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE warnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE suspensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE suspension_appeals ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Helper functions — SECURITY DEFINER so they bypass RLS on the table
-- they check (avoids RLS self-reference/recursion issues and keeps the
-- policies below readable).
CREATE OR REPLACE FUNCTION is_admin(check_user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT COALESCE((SELECT is_admin FROM users WHERE id = check_user_id), FALSE);
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION is_session_member(p_session_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM session_members WHERE session_id = p_session_id AND user_id = p_user_id
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

-- users -----------------------------------------------------------------
CREATE POLICY users_read_policy ON users
    FOR SELECT USING (id = auth.uid() OR is_admin(auth.uid()));

CREATE POLICY users_update_own_policy ON users
    FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid() AND is_admin IS NOT DISTINCT FROM FALSE);
    -- prevents a user from granting themselves admin via a profile-edit call

-- courses -----------------------------------------------------------------
CREATE POLICY courses_read_policy ON courses
    FOR SELECT TO authenticated USING (TRUE);

-- user_courses --------------------------------------------------------------
CREATE POLICY user_courses_policy ON user_courses
    FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- app_settings ------------------------------------------------------------
-- NEW: was entirely missing -> silently broke the host-cap and
-- grace-period subqueries inside sessions_insert_policy / messages_insert_policy.
CREATE POLICY app_settings_select_policy ON app_settings
    FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY app_settings_update_policy ON app_settings
    FOR UPDATE TO authenticated USING (is_admin(auth.uid())) WITH CHECK (is_admin(auth.uid()));

-- study_sessions ------------------------------------------------------------
CREATE POLICY sessions_select_policy ON study_sessions
    FOR SELECT TO authenticated USING (
        EXISTS (SELECT 1 FROM user_courses uc WHERE uc.user_id = auth.uid() AND uc.course_id = study_sessions.course_id)
        AND (
            study_sessions.gender_preference = 'open_to_all'
            OR (study_sessions.gender_preference = 'women_only' AND (SELECT gender FROM users WHERE id = auth.uid()) = 'Female')
            OR (study_sessions.gender_preference = 'men_only' AND (SELECT gender FROM users WHERE id = auth.uid()) = 'Male')
        )
        AND NOT COALESCE((SELECT is_suspended FROM users WHERE id = auth.uid()), FALSE)
    );

CREATE POLICY sessions_insert_policy ON study_sessions
    FOR INSERT TO authenticated WITH CHECK (
        host_id = auth.uid()
        AND NOT COALESCE((SELECT is_suspended FROM users WHERE id = auth.uid()), FALSE)
    );
    -- host cap is re-checked by enforce_host_cap_trigger; kept here too as
    -- defense-in-depth per the PRD's "no single layer is the only gate" stance

-- NEW: was missing entirely -> hosts couldn't edit or cancel via the API at all.
CREATE POLICY sessions_update_policy ON study_sessions
    FOR UPDATE TO authenticated USING (host_id = auth.uid()) WITH CHECK (host_id = auth.uid());

-- session_members -----------------------------------------------------------
-- NEW: was fully locked (RLS on, zero policies) -> "my sessions", chat
-- membership checks and host-control visibility all returned empty.
-- No INSERT policy by design: all joins must go through join_session()
-- (SECURITY DEFINER) so the atomic capacity/eligibility check can't be
-- bypassed by a plain client insert.
CREATE POLICY session_members_select_policy ON session_members
    FOR SELECT TO authenticated USING (
        user_id = auth.uid()
        OR is_session_member(session_members.session_id, auth.uid())
        OR is_admin(auth.uid())
    );

CREATE POLICY session_members_delete_policy ON session_members
    FOR DELETE TO authenticated USING (
        user_id = auth.uid() -- leaving
        OR EXISTS (SELECT 1 FROM study_sessions s WHERE s.id = session_members.session_id AND s.host_id = auth.uid()) -- host removing a member
    );

-- messages ------------------------------------------------------------------
-- NEW: SELECT policy was missing -> chat history was unreadable via the API.
CREATE POLICY messages_select_policy ON messages
    FOR SELECT TO authenticated USING (is_session_member(messages.session_id, auth.uid()));

CREATE POLICY messages_insert_policy ON messages
    FOR INSERT TO authenticated WITH CHECK (
        sender_id = auth.uid()
        AND NOT COALESCE((SELECT is_suspended FROM users WHERE id = auth.uid()), FALSE)
        AND is_session_member(messages.session_id, auth.uid())
        AND EXISTS (
            SELECT 1 FROM study_sessions s
            CROSS JOIN app_settings a
            WHERE s.id = messages.session_id
              AND (s.ends_at + (a.chat_grace_period_days || ' days')::INTERVAL) > NOW()
        )
    );

-- reports ---------------------------------------------------------------
-- NEW: no policies at all previously -> reports could never be submitted.
CREATE POLICY reports_select_policy ON reports
    FOR SELECT TO authenticated USING (reporter_id = auth.uid() OR is_admin(auth.uid()));

CREATE POLICY reports_insert_policy ON reports
    FOR INSERT TO authenticated WITH CHECK (
        reporter_id = auth.uid()
        AND is_session_member(reports.session_id, auth.uid())
        AND EXISTS (SELECT 1 FROM session_members sm WHERE sm.session_id = reports.session_id AND sm.user_id = reports.reported_user_id)
    );

CREATE POLICY reports_update_policy ON reports
    FOR UPDATE TO authenticated USING (is_admin(auth.uid())) WITH CHECK (is_admin(auth.uid()));

-- warnings ----------------------------------------------------------------
CREATE POLICY warnings_select_policy ON warnings
    FOR SELECT TO authenticated USING (user_id = auth.uid() OR is_admin(auth.uid()));

CREATE POLICY warnings_insert_policy ON warnings
    FOR INSERT TO authenticated WITH CHECK (is_admin(auth.uid()));

-- suspensions ---------------------------------------------------------------
CREATE POLICY suspensions_select_policy ON suspensions
    FOR SELECT TO authenticated USING (user_id = auth.uid() OR is_admin(auth.uid()));

CREATE POLICY suspensions_insert_policy ON suspensions
    FOR INSERT TO authenticated WITH CHECK (is_admin(auth.uid()));

CREATE POLICY suspensions_update_policy ON suspensions
    FOR UPDATE TO authenticated USING (is_admin(auth.uid())) WITH CHECK (is_admin(auth.uid()));

-- suspension_appeals ----------------------------------------------------
CREATE POLICY appeals_select_policy ON suspension_appeals
    FOR SELECT TO authenticated USING (user_id = auth.uid() OR is_admin(auth.uid()));

CREATE POLICY appeals_insert_policy ON suspension_appeals
    FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
    -- the "only one pending appeal" rule is enforced by the partial unique index above

CREATE POLICY appeals_update_policy ON suspension_appeals
    FOR UPDATE TO authenticated USING (is_admin(auth.uid())) WITH CHECK (is_admin(auth.uid()));

-- audit_log -----------------------------------------------------------------
-- Admin read-only via the API; rows are written only by SECURITY DEFINER
-- functions (which bypass RLS), never by a direct client insert.
CREATE POLICY audit_log_select_policy ON audit_log
    FOR SELECT TO authenticated USING (is_admin(auth.uid()));

--------------------------------------------------------------------------------
-- END OF SCHEMA
--------------------------------------------------------------------------------