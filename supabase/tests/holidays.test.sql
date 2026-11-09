-- =====================================================================
-- MRKLL booking system — public holiday tests
-- Checks supabase/holidays.sql independently of today's date.
-- =====================================================================

\set ON_ERROR_STOP on
set client_min_messages = warning;
begin;

create function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', label; end if;
  raise notice 'ok - %', label;
end $$;

-- Is a whole local day closed for every package?
create function pg_temp.day_closed(d date) returns boolean language sql as $$
  select bool_and(not slot_is_free(ps.starts_at, ps.ends_at, ps.blocked_until))
     and count(*) > 0
  from (select * from package_slots('starter', d, d)
        union all select * from package_slots('pro', d, d)
        union all select * from package_slots('legend', d, d)) ps;
$$;

create function pg_temp.has_holiday(d date) returns boolean language sql as $$
  select exists (
    select 1 from blackout_periods bp, studio_settings s
    where bp.period = tstzrange(d::timestamp at time zone s.timezone,
                                (d + 1)::timestamp at time zone s.timezone, '[)')
      and bp.reason like 'Festiu %');
$$;

set client_min_messages = notice;

select pg_temp.ok((select count(*) from blackout_periods where reason like 'Festiu %') = 17, '17 holidays loaded once (file is idempotent)');

-- Exact list as verified on the official texts (BOE, DOGC, Gaseta Municipal).
select pg_temp.ok((
  select string_agg(((lower(bp.period) at time zone s.timezone)::date)::text, ',' order by lower(bp.period))
  from blackout_periods bp, studio_settings s where bp.reason like 'Festiu %')
  = '2026-12-08,2026-12-25,2026-12-26,2027-01-01,2027-01-06,2027-03-26,2027-03-29,2027-05-01,2027-05-17,'
    || '2027-06-24,2027-09-11,2027-09-24,2027-10-12,2027-11-01,2027-12-06,2027-12-08,2027-12-25',
  'holiday dates match the official acts exactly');
select pg_temp.ok((select count(distinct period) from blackout_periods where reason like 'Festiu %') = 17, 'no duplicate holidays');
select pg_temp.ok(not exists (
  select 1 from blackout_periods bp, studio_settings s
  where bp.reason like 'Festiu %' and extract(isodow from (lower(bp.period) at time zone s.timezone)) = 7), 'no holiday listed on a Sunday');

-- every listed day is a full local day (00:00 to 24:00 Madrid), also across DST
select pg_temp.ok(bool_and(upper(period) - lower(period) in (interval '24 hours'))
                  , 'each holiday covers exactly one local day')
from blackout_periods where reason like 'Festiu %';
select pg_temp.ok((select lower(period) from blackout_periods where reason like '%Nadal%' and lower(period) < '2027-01-01')
                  = '2026-12-24 23:00:00+00', 'Nadal 2026 starts at 00:00 Madrid (23:00 UTC)');
select pg_temp.ok((select lower(period) from blackout_periods where reason like '%Sant Joan%')
                  = '2027-06-23 22:00:00+00', 'Sant Joan 2027 starts at 00:00 Madrid summer time (22:00 UTC)');

-- national
select pg_temp.ok(pg_temp.has_holiday('2026-12-08') and pg_temp.day_closed('2026-12-08'), 'Immaculada 2026 closed');
select pg_temp.ok(pg_temp.has_holiday('2026-12-25'), 'Nadal 2026 listed');
select pg_temp.ok(pg_temp.has_holiday('2027-01-01') and pg_temp.day_closed('2027-01-01'), 'Cap d''Any 2027 closed');
select pg_temp.ok(pg_temp.has_holiday('2027-01-06') and pg_temp.day_closed('2027-01-06'), 'Reis 2027 closed');
select pg_temp.ok(pg_temp.has_holiday('2027-03-26') and pg_temp.day_closed('2027-03-26'), 'Divendres Sant 2027 closed');
select pg_temp.ok(pg_temp.has_holiday('2027-05-01') and pg_temp.day_closed('2027-05-01'), 'Festa del Treball 2027 (Saturday) closed');
select pg_temp.ok(pg_temp.has_holiday('2027-10-12') and pg_temp.day_closed('2027-10-12'), 'Festa Nacional 2027 closed');
select pg_temp.ok(pg_temp.has_holiday('2027-11-01') and pg_temp.day_closed('2027-11-01'), 'Tots Sants 2027 closed');
select pg_temp.ok(pg_temp.has_holiday('2027-12-06') and pg_temp.day_closed('2027-12-06'), 'Constitució 2027 closed');
select pg_temp.ok(pg_temp.has_holiday('2027-12-08') and pg_temp.day_closed('2027-12-08'), 'Immaculada 2027 closed');
select pg_temp.ok(pg_temp.has_holiday('2027-12-25') and pg_temp.day_closed('2027-12-25'), 'Nadal 2027 (Saturday) closed');
-- Catalonia
select pg_temp.ok(pg_temp.has_holiday('2026-12-26') and pg_temp.day_closed('2026-12-26'), 'Sant Esteve 2026 (Saturday) closed');
select pg_temp.ok(pg_temp.has_holiday('2027-03-29') and pg_temp.day_closed('2027-03-29'), 'Dilluns de Pasqua 2027 closed');
select pg_temp.ok(pg_temp.has_holiday('2027-06-24') and pg_temp.day_closed('2027-06-24'), 'Sant Joan 2027 closed');
select pg_temp.ok(pg_temp.has_holiday('2027-09-11') and pg_temp.day_closed('2027-09-11'), 'Diada 2027 (Saturday) closed');
-- Barcelona local
select pg_temp.ok(pg_temp.has_holiday('2027-05-17') and pg_temp.day_closed('2027-05-17'), 'Pasqua Granada 2027 closed');
select pg_temp.ok(pg_temp.has_holiday('2027-09-24') and pg_temp.day_closed('2027-09-24'), 'La Mercè 2027 closed');

-- neighbours of holidays stay open
select pg_temp.ok(not pg_temp.day_closed('2026-12-07'), 'Monday 7 Dec 2026 open');
select pg_temp.ok(not pg_temp.day_closed('2026-12-09'), 'Wednesday 9 Dec 2026 open');
select pg_temp.ok(not pg_temp.day_closed('2027-03-30'), 'Tuesday after Easter 2027 open');
select pg_temp.ok(not pg_temp.day_closed('2027-09-23'), 'day before La Mercè 2027 open');

rollback;
