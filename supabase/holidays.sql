-- =====================================================================
-- MRKLL Studios — Public holidays (studio closed all day)
-- National (Spain), Catalonia and Barcelona local holidays, from today
-- until the end of 2027. Stored as full local days in blackout_periods.
-- Safe to re-run: existing identical closures are not duplicated.
--
-- Official sources (each date checked on the original text, 2026-11-09)
--   BOE-2026   Resolución de 17 de octubre de 2025, Dirección General de Trabajo,
--              fiestas laborales 2026 — BOE 28/10/2025, BOE-A-2025-21667 (annex, column Cataluña)
--   BOE-2027   Resolución de 8 de octubre de 2026, Dirección General de Trabajo,
--              fiestas laborales 2027 — BOE 13/10/2026, BOE-A-2026-21254 (annex, column Cataluña)
--   DOGC-2026  Ordre EMT/66/2025, de 30 d'abril — DOGC núm. 9406, 06/05/2025 (art. 1)
--   DOGC-2027  Ordre EMT/52/2026, de 25 de març — DOGC núm. 9637, 01/04/2026,
--              CVE-DOGC-A-26089042-2026 (art. 1)
--   BCN-2027   Decret d'Alcaldia ANY2026-15675, de 4 de juny — Gaseta Municipal de
--              Barcelona, 09/06/2026, CSV 6f087656200809ba
--
-- 15 Aug 2027 and 26 Dec 2027 fall on a Sunday and are not in the official
-- lists for Catalonia; the studio is closed on Sundays anyway.
--
-- Yearly maintenance: add 2028 when the Catalan order (usually spring)
-- and the Barcelona decree (usually June) are published.
-- =====================================================================
-- Note: no DO blocks (the Supabase SQL Editor rejects them); checks run in
-- session-only pg_temp functions instead, inside the same transaction.

begin;

create or replace function pg_temp.mrkll_holidays_guard() returns void language plpgsql as $$
begin
  if not exists (select 1 from public.studio_settings) then
    raise exception 'studio_settings is empty: run seed.sql before holidays.sql.';
  end if;
end $$;
select pg_temp.mrkll_holidays_guard();

with holidays (day, name, scope, source) as (
  values
    -- 2026 (remaining)
    (date '2026-12-08', 'La Immaculada',               'Estatal',   'BOE-2026 / DOGC-2026'),
    (date '2026-12-25', 'Nadal',                       'Estatal',   'BOE-2026 / DOGC-2026'),
    (date '2026-12-26', 'Sant Esteve',                 'Catalunya', 'BOE-2026 / DOGC-2026'),
    -- 2027
    (date '2027-01-01', 'Cap d''Any',                  'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-01-06', 'Reis',                        'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-03-26', 'Divendres Sant',              'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-03-29', 'Dilluns de Pasqua Florida',   'Catalunya', 'BOE-2027 / DOGC-2027'),
    (date '2027-05-01', 'Festa del Treball',           'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-05-17', 'Dilluns de Pasqua Granada',   'Barcelona', 'BCN-2027'),
    (date '2027-06-24', 'Sant Joan',                   'Catalunya', 'BOE-2027 / DOGC-2027'),
    (date '2027-09-11', 'Diada Nacional de Catalunya', 'Catalunya', 'BOE-2027 / DOGC-2027'),
    (date '2027-09-24', 'La Mercè',                    'Barcelona', 'BCN-2027'),
    (date '2027-10-12', 'Festa Nacional d''Espanya',   'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-11-01', 'Tots Sants',                  'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-12-06', 'Dia de la Constitució',       'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-12-08', 'La Immaculada',               'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-12-25', 'Nadal',                       'Estatal',   'BOE-2027 / DOGC-2027')
),
ranges as (
  select tstzrange(h.day::timestamp at time zone s.timezone,
                   (h.day + 1)::timestamp at time zone s.timezone, '[)') as period,
         'Festiu ' || h.scope || ': ' || h.name || ' [' || h.source || ']' as reason
  from holidays h
  cross join public.studio_settings s
)
insert into public.blackout_periods (period, reason)
select r.period, r.reason
from ranges r
where not exists (select 1 from public.blackout_periods bp where bp.period = r.period);

commit;
