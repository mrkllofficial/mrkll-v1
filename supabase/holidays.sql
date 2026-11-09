-- =====================================================================
-- MRKLL Studios — Public holidays (studio closed all day)
-- National (Spain), Catalonia and Barcelona local holidays, from today
-- until the end of 2027. Stored as full local days in blackout_periods.
-- Safe to re-run: existing identical closures are not duplicated.
--
-- Official sources
--   [BOE-2027]  Resolución de 8 de octubre de 2026, de la Dirección General de
--               Trabajo — fiestas laborales 2027 (BOE 13/10/2026, BOE-A-2026-21254)
--   [DOGC-2026] Ordre EMT/66/2025, de 30 d'abril — calendari oficial de festes
--               laborals a Catalunya 2026 (DOGC 06/05/2025)
--   [DOGC-2027] Ordre EMT/52/2026, de 25 de març — calendari oficial de festes
--               laborals a Catalunya 2027 (DOGC núm. 9637, 01/04/2026)
--   [BCN-2027]  Decret d'Alcaldia ANY2026-15675, de 4 de juny de 2026 — festes
--               locals 2027 al terme municipal de Barcelona (Gaseta Municipal)
--
-- Yearly maintenance: add 2028 when the Catalan order (usually spring)
-- and the Barcelona decree (usually June) are published.
-- =====================================================================

begin;

with holidays (day, name, scope, source) as (
  values
    -- 2026 (remaining)
    (date '2026-12-08', 'La Immaculada',               'Estatal',   'BOE / DOGC-2026'),
    (date '2026-12-25', 'Nadal',                       'Estatal',   'BOE / DOGC-2026'),
    (date '2026-12-26', 'Sant Esteve',                 'Catalunya', 'DOGC-2026'),
    -- 2027
    (date '2027-01-01', 'Cap d''Any',                  'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-01-06', 'Reis',                        'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-03-26', 'Divendres Sant',              'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-03-29', 'Dilluns de Pasqua Florida',   'Catalunya', 'BOE-2027 / DOGC-2027'),
    (date '2027-05-01', 'Festa del Treball',           'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-05-17', 'Dilluns de Pasqua Granada',   'Barcelona', 'BCN-2027'),
    (date '2027-06-24', 'Sant Joan',                   'Catalunya', 'BOE-2027 / DOGC-2027'),
    (date '2027-08-15', 'L''Assumpció (diumenge)',     'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-09-11', 'Diada Nacional de Catalunya', 'Catalunya', 'BOE-2027 / DOGC-2027'),
    (date '2027-09-24', 'La Mercè',                    'Barcelona', 'BCN-2027'),
    (date '2027-10-12', 'Festa Nacional d''Espanya',   'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-11-01', 'Tots Sants',                  'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-12-06', 'Dia de la Constitució',       'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-12-08', 'La Immaculada',               'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-12-25', 'Nadal',                       'Estatal',   'BOE-2027 / DOGC-2027'),
    (date '2027-12-26', 'Sant Esteve (diumenge)',      'Catalunya', 'BOE-2027 / DOGC-2027')
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
