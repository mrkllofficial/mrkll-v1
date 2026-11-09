-- =====================================================================
-- MRKLL Studios — Initial data (Phase 2.1)
-- Safe to re-run: every statement is an upsert.
-- =====================================================================

begin;

-- Studio configuration (approved values)
insert into public.studio_settings (
  id, timezone, buffer_minutes, min_notice_hours, max_advance_days,
  checkout_expiry_minutes, hold_minutes, max_active_holds_per_ip)
values (true, 'Europe/Madrid', 30, 24, 90, 30, 35, 3)
on conflict (id) do update set
  timezone                = excluded.timezone,
  buffer_minutes          = excluded.buffer_minutes,
  min_notice_hours        = excluded.min_notice_hours,
  max_advance_days        = excluded.max_advance_days,
  checkout_expiry_minutes = excluded.checkout_expiry_minutes,
  hold_minutes            = excluded.hold_minutes,
  max_active_holds_per_ip = excluded.max_active_holds_per_ip;

-- Opening hours: Monday–Saturday 10:00–22:00, Sunday closed
delete from public.opening_hours;
insert into public.opening_hours (weekday, opens_at, closes_at)
select wd, time '10:00', time '22:00' from generate_series(1, 6) wd;

-- Packages
insert into public.packages (id, name, duration_minutes, price_cents, currency, active, sort_order) values
  ('starter', 'Recording Starter', 120, 12000, 'eur', true, 1),
  ('pro',     'Recording Pro',     240, 20000, 'eur', true, 2),
  ('legend',  'Recording Legend',  360, 28000, 'eur', true, 3)
on conflict (id) do update set
  name             = excluded.name,
  duration_minutes = excluded.duration_minutes,
  price_cents      = excluded.price_cents,
  currency         = excluded.currency,
  active           = excluded.active,
  sort_order       = excluded.sort_order;

-- Fixed start times on a 2h30 grid (2h session + 30 min buffer):
--   Starter = 1 block, Pro = 2 blocks, Legend = 3 blocks, day = 5 blocks.
-- Any combination stays on the grid, so no booking ever fragments the day.
delete from public.package_start_times where package_id in ('starter', 'pro', 'legend');
insert into public.package_start_times (package_id, start_time) values
  ('starter', '10:00'), ('starter', '12:30'), ('starter', '15:00'), ('starter', '17:30'), ('starter', '20:00'),
  ('pro',     '10:00'), ('pro',     '12:30'), ('pro',     '15:00'), ('pro',     '17:30'),
  ('legend',  '10:00'), ('legend',  '12:30'), ('legend',  '15:00');

commit;
