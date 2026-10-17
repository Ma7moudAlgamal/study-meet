-- outbound_notifications is written to exclusively by SECURITY DEFINER
-- functions (triggers), never by a direct client insert. The only reader
-- is the server-side email worker, which uses the service_role key and
-- bypasses RLS entirely. So: RLS on, no client-facing policies at all —
-- regular users can't touch this table through the API in either direction.
ALTER TABLE outbound_notifications ENABLE ROW LEVEL SECURITY;

-- Admins can read the queue from Studio/admin tooling if needed.
CREATE POLICY outbound_notifications_admin_select ON outbound_notifications
    FOR SELECT TO authenticated USING (is_admin(auth.uid()));