-- Run this in the Supabase SQL Editor (project: ayegbhwjbakcmuxsmint) to
-- schedule the notification sender. It needs the pg_cron and pg_net extensions.
-- Safe to re-run: it replaces any existing job with the same name.
--
-- History: this job used to run every minute ('* * * * *'). That is 1,440 runs
-- a day, each writing cron and pg_net bookkeeping rows, and it was the most
-- likely cause of the Disk IO Budget warnings. Now it runs every 5 minutes,
-- and only calls the function when at least one device has notifications on.
--
-- Every 5 minutes is enough: every schedule block starts on :00 or :30, and
-- reminder lead times are 5/10/15 min (enforced by a CHECK constraint in
-- migration 00000000000005). The function snaps to the current 5-minute slot.
--
-- BEFORE RUNNING: deploy the updated Edge Function first
-- (supabase functions deploy send-schedule-notifications), otherwise the old
-- function only sends when a call happens to land on the exact minute.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 1. Remove the old every-minute job (no error if it doesn't exist).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'onesie-schedule-notifications';

-- 2. Schedule the new one.
-- Replace REPLACE_WITH_CRON_SECRET with the same value you set as the
-- CRON_SECRET Edge Function secret. The publishable key below is public/safe
-- and authorizes the request to the function gateway; x-cron-secret is the
-- real check the function performs.
SELECT cron.schedule(
  'onesie-schedule-notifications',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://ayegbhwjbakcmuxsmint.supabase.co/functions/v1/send-schedule-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_SGh1NtTqX25Pi7UrGfJDBA_EgjwYKUz',
      'Authorization', 'Bearer sb_publishable_SGh1NtTqX25Pi7UrGfJDBA_EgjwYKUz',
      'x-cron-secret', 'REPLACE_WITH_CRON_SECRET'
    ),
    body := '{}'::jsonb
  )
  WHERE EXISTS (SELECT 1 FROM public.push_subscriptions WHERE schedule_notifications);
  $$
);

-- 3. pg_cron logs every run to cron.job_run_details and never deletes them.
--    Clear the backlog once, then keep 7 days with a daily cleanup job.
DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days';

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'onesie-cleanup-cron-history';
SELECT cron.schedule(
  'onesie-cleanup-cron-history',
  '17 3 * * *',
  $$ DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days' $$
);

-- 4. Check: should list exactly these two jobs.
SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;

-- To remove later:
--   SELECT cron.unschedule('onesie-schedule-notifications');
--   SELECT cron.unschedule('onesie-cleanup-cron-history');
