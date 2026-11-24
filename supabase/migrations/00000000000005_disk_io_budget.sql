-- Disk IO budget fixes + caregiver-removal permission fix.
-- Safe to run more than once (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS).
-- Run in the Supabase SQL Editor. Everything runs in one transaction, so a
-- failure leaves the database unchanged.
--
-- Pairs with supabase/functions/send-schedule-notifications/cron.sql, which
-- slows the notification cron from every minute to every 5 minutes.

BEGIN;

-- ============================================================
-- 1. Indexes
-- ============================================================
-- Every tracker query is "rows for this baby, newest first". Without these,
-- each query (and every RLS check) scans the whole table.

CREATE INDEX IF NOT EXISTS feeding_sessions_baby_start_idx ON public.feeding_sessions (baby_profile_id, start_time DESC);
CREATE INDEX IF NOT EXISTS sleep_sessions_baby_start_idx   ON public.sleep_sessions   (baby_profile_id, start_time DESC);
CREATE INDEX IF NOT EXISTS pumping_sessions_baby_start_idx ON public.pumping_sessions (baby_profile_id, start_time DESC);
CREATE INDEX IF NOT EXISTS diaper_changes_baby_ts_idx      ON public.diaper_changes   (baby_profile_id, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS bottle_feeds_baby_ts_idx        ON public.bottle_feeds     (baby_profile_id, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS weight_logs_baby_date_idx       ON public.weight_logs      (baby_profile_id, date);
CREATE INDEX IF NOT EXISTS height_logs_baby_date_idx       ON public.height_logs      (baby_profile_id, date);

CREATE INDEX IF NOT EXISTS caregivers_user_id_idx          ON public.caregivers (user_id);
CREATE INDEX IF NOT EXISTS caregivers_family_id_idx        ON public.caregivers (family_id);
CREATE INDEX IF NOT EXISTS baby_profiles_family_id_idx     ON public.baby_profiles (family_id);
CREATE INDEX IF NOT EXISTS family_invites_family_id_idx    ON public.family_invites (family_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_caregiver_idx ON public.push_subscriptions (caregiver_id);

-- ============================================================
-- 2. Helper functions: STABLE + pinned search_path
-- ============================================================
-- Without STABLE, Postgres treats the function as volatile and may call it once
-- per row. SECURITY DEFINER functions should also pin search_path.

CREATE OR REPLACE FUNCTION public.get_user_family_ids(_user_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT array_agg(family_id) FROM public.caregivers WHERE user_id = _user_id;
$function$;

-- Families where the user is the owner (used by the caregiver-removal policy).
CREATE OR REPLACE FUNCTION public.get_user_owned_family_ids(_user_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT array_agg(family_id) FROM public.caregivers WHERE user_id = _user_id AND role = 'owner';
$function$;

REVOKE EXECUTE ON FUNCTION public.get_user_owned_family_ids(uuid) FROM anon;

-- ============================================================
-- 3. RLS policies: evaluate the user's families once per query
-- ============================================================
-- Wrapping in (SELECT ...) turns the call into an "initplan" that runs once per
-- statement instead of once per row (Supabase advisor: auth_rls_initplan).
-- Same access rules as before except caregivers DELETE (section 4).

-- families
DROP POLICY IF EXISTS "families: members can read" ON public.families;
CREATE POLICY "families: members can read" ON public.families
  FOR SELECT TO authenticated
  USING (id = ANY ((SELECT public.get_user_family_ids((SELECT auth.uid())))::uuid[]));

-- baby_profiles
DROP POLICY IF EXISTS "baby_profiles: members can insert" ON public.baby_profiles;
CREATE POLICY "baby_profiles: members can insert" ON public.baby_profiles
  FOR INSERT TO authenticated
  WITH CHECK (family_id = ANY ((SELECT public.get_user_family_ids((SELECT auth.uid())))::uuid[]));

DROP POLICY IF EXISTS "baby_profiles: members can read" ON public.baby_profiles;
CREATE POLICY "baby_profiles: members can read" ON public.baby_profiles
  FOR SELECT TO authenticated
  USING (family_id = ANY ((SELECT public.get_user_family_ids((SELECT auth.uid())))::uuid[]));

DROP POLICY IF EXISTS "baby_profiles: members can update" ON public.baby_profiles;
CREATE POLICY "baby_profiles: members can update" ON public.baby_profiles
  FOR UPDATE TO authenticated
  USING (family_id = ANY ((SELECT public.get_user_family_ids((SELECT auth.uid())))::uuid[]));

-- caregivers (read)
DROP POLICY IF EXISTS "caregivers: members can read" ON public.caregivers;
CREATE POLICY "caregivers: members can read" ON public.caregivers
  FOR SELECT TO authenticated
  USING (family_id = ANY ((SELECT public.get_user_family_ids((SELECT auth.uid())))::uuid[]));

-- family_invites
DROP POLICY IF EXISTS "family_invites: members can read" ON public.family_invites;
CREATE POLICY "family_invites: members can read" ON public.family_invites
  FOR SELECT TO authenticated
  USING (family_id = ANY ((SELECT public.get_user_family_ids((SELECT auth.uid())))::uuid[]));

DROP POLICY IF EXISTS "family_invites: owners can insert" ON public.family_invites;
CREATE POLICY "family_invites: owners can insert" ON public.family_invites
  FOR INSERT TO authenticated
  WITH CHECK (
    family_id = ANY ((SELECT public.get_user_family_ids((SELECT auth.uid())))::uuid[])
    AND created_by = (SELECT auth.uid())
  );

-- Tracker tables: identical rule on each.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['feeding_sessions','diaper_changes','sleep_sessions','pumping_sessions','bottle_feeds','weight_logs','height_logs']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || ': members can all', t);
    EXECUTE format($p$
      CREATE POLICY %I ON public.%I
        FOR ALL TO authenticated
        USING (baby_profile_id IN (
          SELECT bp.id FROM public.baby_profiles bp
          WHERE bp.family_id = ANY ((SELECT public.get_user_family_ids((SELECT auth.uid())))::uuid[])
        ))
    $p$, t || ': members can all', t);
  END LOOP;
END $$;

-- push_subscriptions
DROP POLICY IF EXISTS "push_subscriptions: owner can read" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions: owner can read" ON public.push_subscriptions
  FOR SELECT USING (caregiver_id IN (SELECT id FROM public.caregivers WHERE user_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS "push_subscriptions: owner can insert" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions: owner can insert" ON public.push_subscriptions
  FOR INSERT WITH CHECK (caregiver_id IN (SELECT id FROM public.caregivers WHERE user_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS "push_subscriptions: owner can update" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions: owner can update" ON public.push_subscriptions
  FOR UPDATE USING (caregiver_id IN (SELECT id FROM public.caregivers WHERE user_id = (SELECT auth.uid())))
  WITH CHECK (caregiver_id IN (SELECT id FROM public.caregivers WHERE user_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS "push_subscriptions: owner can delete" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions: owner can delete" ON public.push_subscriptions
  FOR DELETE USING (caregiver_id IN (SELECT id FROM public.caregivers WHERE user_id = (SELECT auth.uid())));

-- ============================================================
-- 4. SECURITY FIX: only the family owner can remove caregivers
-- ============================================================
-- Before: any member could delete any caregiver row in their family, including
-- the owner's (the owner check was UI-only). Now: only an owner, and never
-- their own row (which would orphan the family).

DROP POLICY IF EXISTS "caregivers: owners can delete" ON public.caregivers;
CREATE POLICY "caregivers: owners can delete" ON public.caregivers
  FOR DELETE TO authenticated
  USING (
    family_id = ANY ((SELECT public.get_user_owned_family_ids((SELECT auth.uid())))::uuid[])
    AND user_id <> (SELECT auth.uid())
  );

-- ============================================================
-- 5. Guard the 5-minute cron assumption
-- ============================================================
-- The cron now runs every 5 minutes. That only works because every schedule
-- block starts on :00/:30 and lead times are multiples of 5. Enforce the latter.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'push_subscriptions_before_minutes_check'
      AND conrelid = 'public.push_subscriptions'::regclass
  ) THEN
    UPDATE public.push_subscriptions SET before_minutes = 10 WHERE before_minutes NOT IN (5, 10, 15);
    ALTER TABLE public.push_subscriptions
      ADD CONSTRAINT push_subscriptions_before_minutes_check CHECK (before_minutes IN (5, 10, 15));
  END IF;
END $$;

COMMIT;
