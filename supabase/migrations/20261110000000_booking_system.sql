-- =====================================================================
-- MRKLL Studios — Booking system (Phase 2.1)
-- Target: Supabase PostgreSQL (15+). Run in the SQL Editor of the
-- STAGING project first. Idempotency: run once on an empty project.
--
-- Principles
--   * The database is the single guarantee against double bookings:
--     an EXCLUDE constraint on a tstzrange rejects any overlap between
--     active bookings, even under concurrent requests.
--   * All instants are stored as timestamptz (UTC). Studio-local times
--     are converted with AT TIME ZONE studio_settings.timezone, so DST
--     changes in Europe/Madrid are handled by PostgreSQL.
--   * Nothing is reachable from the browser: RLS is enabled with no
--     policies and every function is executable by service_role only.
-- =====================================================================
-- Note: no DO blocks (the Supabase SQL Editor rejects them); checks run in
-- session-only pg_temp functions instead, inside the same transaction.

begin;

-- Guard: this migration must run exactly once, on a project without it.
create or replace function pg_temp.mrkll_m1_guard() returns void language plpgsql as $$
begin
  if to_regclass('public.bookings') is not null then
    raise exception 'Migration 1 is already applied (public.bookings exists): skip this file and run the next one.';
  end if;
end $$;
select pg_temp.mrkll_m1_guard();

-- ---------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------

create type public.booking_status as enum (
  'pending_payment',  -- slot held while the customer is on Stripe Checkout
  'confirmed',        -- payment verified by the Stripe webhook
  'needs_review',     -- paid, but something did not match: slot kept, studio checks manually
  'expired',          -- hold expired / Stripe session expired
  'cancelled',        -- hold released by the customer, or booking cancelled by the studio
  'payment_conflict', -- paid after the hold expired and the slot was taken: must be refunded
  'refunded'          -- refunded (Stripe charge.refunded)
);

-- ---------------------------------------------------------------------
-- Configuration tables
-- ---------------------------------------------------------------------

create table public.studio_settings (
  id                        boolean primary key default true check (id),  -- single row
  timezone                  text    not null default 'Europe/Madrid',
  buffer_minutes            int     not null default 30  check (buffer_minutes between 0 and 240),
  min_notice_hours          int     not null default 24  check (min_notice_hours between 0 and 720),
  max_advance_days          int     not null default 90  check (max_advance_days between 1 and 365),
  checkout_expiry_minutes   int     not null default 30  check (checkout_expiry_minutes between 30 and 1440),
  hold_minutes              int     not null default 35,
  max_active_holds_per_ip   int     not null default 3   check (max_active_holds_per_ip between 1 and 50),
  updated_at                timestamptz not null default now(),
  -- the hold must always outlive the Stripe Checkout session
  constraint hold_outlives_checkout check (hold_minutes > checkout_expiry_minutes),
  -- raises an error for unknown time zone names
  constraint valid_timezone check ((timestamptz '2000-01-01 00:00+00' at time zone timezone) is not null)
);

comment on table public.studio_settings is
  'Single-row studio configuration. Changing values here changes availability immediately.';

create table public.opening_hours (
  weekday   smallint not null check (weekday between 1 and 7),  -- ISO: 1 = Monday … 7 = Sunday
  opens_at  time     not null,
  closes_at time     not null,
  primary key (weekday, opens_at),
  check (closes_at > opens_at)
);

comment on table public.opening_hours is
  'Studio opening hours per ISO weekday (1=Mon … 7=Sun), local studio time. No row = closed.';

create table public.packages (
  id               text primary key check (id ~ '^[a-z0-9_-]{1,32}$'),
  name             text not null,
  duration_minutes int  not null check (duration_minutes between 30 and 1440),
  price_cents      int  not null check (price_cents > 0),
  currency         text not null default 'eur' check (currency ~ '^[a-z]{3}$'),
  active           boolean not null default true,
  sort_order       int not null default 0,
  updated_at       timestamptz not null default now()
);

create table public.package_start_times (
  package_id text not null references public.packages(id) on delete cascade,
  start_time time not null,
  primary key (package_id, start_time)
);

comment on table public.package_start_times is
  'Fixed list of allowed start times (local studio time) for each package.';

create table public.blackout_periods (
  id         uuid primary key default gen_random_uuid(),
  period     tstzrange not null check (not isempty(period) and lower(period) is not null and upper(period) is not null),
  reason     text,
  created_at timestamptz not null default now()
);

comment on table public.blackout_periods is
  'Closures (holidays, maintenance). Enter with an explicit offset, e.g. [2026-12-24 00:00+01, 2026-12-27 00:00+01).';

-- ---------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------

create table public.bookings (
  id                         uuid primary key default gen_random_uuid(),
  reference                  text not null unique,
  package_id                 text not null references public.packages(id),
  status                     public.booking_status not null default 'pending_payment',
  source                     text not null default 'website' check (source in ('website','admin')),

  starts_at                  timestamptz not null,
  ends_at                    timestamptz not null,
  blocked_until              timestamptz not null,   -- ends_at + buffer
  during                     tstzrange generated always as (tstzrange(starts_at, blocked_until, '[)')) stored,

  price_cents                int  not null check (price_cents >= 0),
  currency                   text not null check (currency ~ '^[a-z]{3}$'),

  hold_expires_at            timestamptz,
  release_token_hash         text,
  client_ip_hash             text,

  stripe_checkout_session_id text unique,
  stripe_payment_intent_id   text unique,
  amount_paid_cents          int,
  currency_paid              text,

  customer_name              text,
  customer_email             text,
  customer_phone             text,
  admin_notes                text,

  customer_email_sent_at     timestamptz,
  studio_email_sent_at       timestamptz,

  confirmed_at               timestamptz,
  released_at                timestamptz,
  refunded_at                timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint ends_after_start   check (ends_at > starts_at),
  constraint buffer_after_end   check (blocked_until >= ends_at),
  constraint pending_needs_hold check (status <> 'pending_payment' or hold_expires_at is not null)
);

-- THE KEY RULE: no two active bookings may overlap (buffer included).
-- Added with dynamic SQL because the SQL Editor's parser does not know
-- EXCLUDE constraints; the constraint itself is a plain PostgreSQL one.
create or replace function pg_temp.mrkll_m1_overlap_rule() returns void language plpgsql as $$
begin
  execute $ddl$
    alter table public.bookings
      add constraint bookings_no_overlap
      exclude using gist (during with &&)
      where (status in ('pending_payment', 'confirmed', 'needs_review'))
  $ddl$;
end $$;
select pg_temp.mrkll_m1_overlap_rule();

create index bookings_pending_idx on public.bookings (hold_expires_at) where status = 'pending_payment';
create index bookings_during_idx  on public.bookings using gist (during);
create index bookings_ip_idx      on public.bookings (client_ip_hash) where status = 'pending_payment';
create index bookings_pi_idx      on public.bookings (stripe_payment_intent_id);

comment on table public.bookings is
  'All bookings and temporary holds. Studio staff may insert manual bookings: set package_id, starts_at (with offset), status=confirmed, source=admin — the other fields are filled automatically.';

create table public.stripe_events (
  id           text primary key,          -- evt_...
  type         text not null,
  booking_id   uuid references public.bookings(id) on delete set null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

-- ---------------------------------------------------------------------
-- Helpers & triggers
-- ---------------------------------------------------------------------

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger studio_settings_touch before update on public.studio_settings
  for each row execute function public.touch_updated_at();
create trigger packages_touch before update on public.packages
  for each row execute function public.touch_updated_at();
create trigger bookings_touch before update on public.bookings
  for each row execute function public.touch_updated_at();

create function public.new_booking_reference() returns text
language sql volatile set search_path = public as $$
  select 'MRK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
$$;

-- Fills derived fields so that manual (admin) bookings only need
-- package_id + starts_at. Website bookings pass everything explicitly.
create function public.bookings_fill_defaults() returns trigger
language plpgsql set search_path = public as $$
declare
  v_pkg public.packages;
  v_buffer int;
begin
  select * into v_pkg from public.packages where id = new.package_id;
  if not found then
    raise exception 'PACKAGE_NOT_FOUND' using errcode = 'P0001';
  end if;
  select buffer_minutes into v_buffer from public.studio_settings;

  if tg_op = 'INSERT' then
    new.reference     := coalesce(new.reference, public.new_booking_reference());
    new.price_cents   := coalesce(new.price_cents, v_pkg.price_cents);
    new.currency      := coalesce(new.currency, v_pkg.currency);
    new.ends_at       := coalesce(new.ends_at, new.starts_at + make_interval(mins => v_pkg.duration_minutes));
    new.blocked_until := coalesce(new.blocked_until, new.ends_at + make_interval(mins => coalesce(v_buffer, 0)));
    if new.status = 'confirmed' and new.confirmed_at is null then
      new.confirmed_at := now();
    end if;
  else
    -- Studio moved the start (or changed package) without touching the end:
    -- keep the package duration.
    if (new.starts_at is distinct from old.starts_at or new.package_id is distinct from old.package_id)
       and new.ends_at is not distinct from old.ends_at then
      new.ends_at := new.starts_at + make_interval(mins => v_pkg.duration_minutes);
    end if;
    if new.ends_at is distinct from old.ends_at then
      new.blocked_until := new.ends_at + make_interval(mins => coalesce(v_buffer, 0));
    end if;
  end if;
  return new;
end $$;

create trigger bookings_fill_defaults before insert or update of starts_at, ends_at, package_id
  on public.bookings for each row execute function public.bookings_fill_defaults();

-- Is the interval [p_starts, p_blocked_until) free of active bookings and closures?
create function public.slot_is_free(p_starts timestamptz, p_ends timestamptz, p_blocked_until timestamptz)
returns boolean
language sql stable set search_path = public as $$
  select not exists (
           select 1 from public.bookings b
           where b.during && tstzrange(p_starts, p_blocked_until, '[)')
             and (b.status in ('confirmed', 'needs_review')
                  or (b.status = 'pending_payment' and b.hold_expires_at > now())))
     and not exists (
           select 1 from public.blackout_periods bp
           where bp.period && tstzrange(p_starts, p_ends, '[)'));
$$;

-- All candidate slots of a package between two local dates, with availability.
create function public.package_slots(p_package_id text, p_from date, p_to date)
returns table (
  slot_date     date,
  start_time    time,
  end_time      time,
  starts_at     timestamptz,
  ends_at       timestamptz,
  blocked_until timestamptz,
  bookable      boolean,   -- respects notice / horizon window
  available     boolean    -- bookable AND free
)
language sql stable set search_path = public as $$
  with s as (select * from public.studio_settings),
  p as (select * from public.packages where id = p_package_id and active),
  today as (select (now() at time zone s.timezone)::date as d from s),
  days as (select p_from + i as d from generate_series(0, p_to - p_from) i),
  cand as (
    select d.d as slot_date,
           st.start_time,
           ((d.d + st.start_time) + make_interval(mins => p.duration_minutes))::time as end_time,
           (d.d + st.start_time) at time zone s.timezone as starts_at,
           ((d.d + st.start_time) + make_interval(mins => p.duration_minutes)) at time zone s.timezone as ends_at,
           s.buffer_minutes, s.min_notice_hours, s.max_advance_days
    from days d
    cross join p
    cross join s
    join public.package_start_times st on st.package_id = p.id
    where exists (
      select 1 from public.opening_hours oh
      where oh.weekday = extract(isodow from d.d)
        and st.start_time >= oh.opens_at
        and (d.d + st.start_time) + make_interval(mins => p.duration_minutes) <= d.d + oh.closes_at)
  )
  select c.slot_date, c.start_time, c.end_time, c.starts_at, c.ends_at,
         c.ends_at + make_interval(mins => c.buffer_minutes) as blocked_until,
         (c.starts_at >= now() + make_interval(hours => c.min_notice_hours)
          and c.slot_date <= (select d from today) + c.max_advance_days) as bookable,
         (c.starts_at >= now() + make_interval(hours => c.min_notice_hours)
          and c.slot_date <= (select d from today) + c.max_advance_days
          and public.slot_is_free(c.starts_at, c.ends_at,
                                  c.ends_at + make_interval(mins => c.buffer_minutes))) as available
  from cand c
  order by c.slot_date, c.start_time;
$$;

-- ---------------------------------------------------------------------
-- Public API (called from Vercel Functions with the secret key only)
-- ---------------------------------------------------------------------

-- Calendar for one package. One row per day in [p_from, p_to] (max 62 days).
-- status: available | unavailable | closed | past | out_of_range
create function public.get_availability(p_package_id text, p_from date, p_to date)
returns table (day date, status text, slots jsonb)
language plpgsql stable set search_path = public as $$
declare
  v_s public.studio_settings;
  v_today date;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'INVALID_RANGE' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.packages where id = p_package_id and active) then
    raise exception 'PACKAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  select * into v_s from public.studio_settings;
  v_today := (now() at time zone v_s.timezone)::date;

  return query
  with days as (select p_from + i as d from generate_series(0, p_to - p_from) i),
  sl as (select * from public.package_slots(p_package_id, p_from, p_to))
  select d.d,
         case
           when d.d < v_today then 'past'
           when d.d > v_today + v_s.max_advance_days then 'out_of_range'
           when not exists (select 1 from public.opening_hours oh where oh.weekday = extract(isodow from d.d))
             or not exists (select 1 from sl where sl.slot_date = d.d) then 'closed'
           when exists (select 1 from sl where sl.slot_date = d.d and sl.available) then 'available'
           else 'unavailable'
         end,
         case
           when d.d < v_today or d.d > v_today + v_s.max_advance_days then '[]'::jsonb
           else coalesce((
             select jsonb_agg(jsonb_build_object(
                      'start', to_char(sl.start_time, 'HH24:MI'),
                      'end',   to_char(sl.end_time,   'HH24:MI'),
                      'available', sl.available)
                    order by sl.start_time)
             from sl where sl.slot_date = d.d), '[]'::jsonb)
         end
  from days d
  order by d.d;
end $$;

-- Temporarily hold a slot before redirecting to Stripe Checkout.
-- Errors (message): PACKAGE_NOT_FOUND, SLOT_NOT_BOOKABLE, SLOT_UNAVAILABLE, TOO_MANY_HOLDS
create function public.create_booking_hold(
  p_package_id         text,
  p_date               date,
  p_start_time         time,
  p_ip_hash            text,
  p_release_token_hash text
)
returns table (
  booking_id              uuid,
  reference               text,
  package_id              text,
  package_name            text,
  duration_minutes        int,
  starts_at               timestamptz,
  ends_at                 timestamptz,
  hold_expires_at         timestamptz,
  checkout_expires_at     timestamptz,
  price_cents             int,
  currency                text,
  timezone                text
)
language plpgsql volatile set search_path = public as $$
declare
  v_s    public.studio_settings;
  v_p    public.packages;
  v_slot record;
  v_id   uuid;
  v_ref  text;
  v_try  int := 0;
begin
  if p_release_token_hash is null or length(p_release_token_hash) < 32 then
    raise exception 'INVALID_TOKEN' using errcode = 'P0001';
  end if;

  select * into v_s from public.studio_settings;
  select * into v_p from public.packages p where p.id = p_package_id and p.active;
  if not found then
    raise exception 'PACKAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- The slot must be one of the package's fixed slots, inside opening
  -- hours, notice and horizon windows.
  select * into v_slot
  from public.package_slots(p_package_id, p_date, p_date) ps
  where ps.start_time = p_start_time;

  if not found or not v_slot.bookable then
    raise exception 'SLOT_NOT_BOOKABLE' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.blackout_periods bp
             where bp.period && tstzrange(v_slot.starts_at, v_slot.ends_at, '[)')) then
    raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  -- Anti-abuse: limit concurrent active holds per (hashed) client IP.
  if p_ip_hash is not null and (
       select count(*) from public.bookings b
       where b.client_ip_hash = p_ip_hash
         and b.status = 'pending_payment'
         and b.hold_expires_at > now()) >= v_s.max_active_holds_per_ip then
    raise exception 'TOO_MANY_HOLDS' using errcode = 'P0001';
  end if;

  -- Lazily expire stale holds that overlap the requested interval.
  update public.bookings b
     set status = 'expired', released_at = now()
   where b.status = 'pending_payment'
     and b.hold_expires_at <= now()
     and b.during && tstzrange(v_slot.starts_at, v_slot.blocked_until, '[)');

  loop
    begin
      insert into public.bookings as b (
        reference, package_id, status, source,
        starts_at, ends_at, blocked_until,
        price_cents, currency,
        hold_expires_at, release_token_hash, client_ip_hash)
      values (
        public.new_booking_reference(), v_p.id, 'pending_payment', 'website',
        v_slot.starts_at, v_slot.ends_at, v_slot.blocked_until,
        v_p.price_cents, v_p.currency,
        now() + make_interval(mins => v_s.hold_minutes), p_release_token_hash, p_ip_hash)
      returning b.id, b.reference into v_id, v_ref;
      exit;
    exception
      when exclusion_violation then
        raise exception 'SLOT_UNAVAILABLE' using errcode = 'P0001';
      when unique_violation then
        v_try := v_try + 1;           -- reference collision: retry
        if v_try >= 5 then raise; end if;
    end;
  end loop;

  return query
  select v_id, v_ref, v_p.id, v_p.name, v_p.duration_minutes,
         v_slot.starts_at, v_slot.ends_at,
         now() + make_interval(mins => v_s.hold_minutes),
         now() + make_interval(mins => v_s.checkout_expiry_minutes),
         v_p.price_cents, v_p.currency, v_s.timezone;
end $$;

-- Link the Stripe Checkout Session to the hold.
create function public.attach_checkout_session(p_booking_id uuid, p_session_id text)
returns boolean
language plpgsql volatile set search_path = public as $$
begin
  update public.bookings
     set stripe_checkout_session_id = p_session_id
   where id = p_booking_id
     and status = 'pending_payment'
     and (stripe_checkout_session_id is null or stripe_checkout_session_id = p_session_id);
  return found;
end $$;

-- Confirm after a verified checkout.session.completed (payment_status = paid).
-- Returns: confirmed | already_confirmed | needs_review | conflict | not_found | session_mismatch | ignored
create function public.confirm_booking(
  p_booking_id     uuid,
  p_session_id     text,
  p_payment_intent text,
  p_amount_cents   int,
  p_currency       text,
  p_customer_name  text,
  p_customer_email text,
  p_customer_phone text
)
returns text
language plpgsql volatile set search_path = public as $$
declare
  v_b public.bookings;
  v_target public.booking_status;
begin
  select * into v_b from public.bookings where id = p_booking_id for update;
  if not found then
    return 'not_found';
  end if;

  if v_b.stripe_checkout_session_id is not null and v_b.stripe_checkout_session_id <> p_session_id then
    return 'session_mismatch';
  end if;

  if v_b.status = 'confirmed' then
    return 'already_confirmed';
  elsif v_b.status = 'needs_review' then
    return 'needs_review';
  elsif v_b.status = 'payment_conflict' then
    return 'conflict';
  elsif v_b.status = 'refunded' then
    return 'ignored';
  end if;

  -- pending_payment, expired or cancelled: payment is real, try to keep the slot.
  v_target := case
                when p_amount_cents is distinct from v_b.price_cents
                  or lower(p_currency) is distinct from v_b.currency then 'needs_review'
                else 'confirmed'
              end;

  begin
    update public.bookings
       set status                     = v_target,
           stripe_checkout_session_id = p_session_id,
           stripe_payment_intent_id   = p_payment_intent,
           amount_paid_cents          = p_amount_cents,
           currency_paid              = lower(p_currency),
           customer_name              = nullif(left(p_customer_name, 200), ''),
           customer_email             = nullif(lower(left(p_customer_email, 320)), ''),
           customer_phone             = nullif(left(p_customer_phone, 50), ''),
           confirmed_at               = case when v_target = 'confirmed' then now() else null end,
           hold_expires_at            = null,
           released_at                = null
     where id = p_booking_id;
  exception when exclusion_violation then
    -- The hold had been released and someone else now owns the slot.
    update public.bookings
       set status                     = 'payment_conflict',
           stripe_checkout_session_id = p_session_id,
           stripe_payment_intent_id   = p_payment_intent,
           amount_paid_cents          = p_amount_cents,
           currency_paid              = lower(p_currency),
           customer_name              = nullif(left(p_customer_name, 200), ''),
           customer_email             = nullif(lower(left(p_customer_email, 320)), ''),
           customer_phone             = nullif(left(p_customer_phone, 50), '')
     where id = p_booking_id;
    return 'conflict';
  end;

  return v_target::text;
end $$;

-- Release a hold (Stripe session expired, or customer cancelled).
-- Must be authenticated by the Stripe session id or by the release token hash.
create function public.release_hold(
  p_booking_id         uuid,
  p_reason             text,
  p_session_id         text default null,
  p_release_token_hash text default null
)
returns boolean
language plpgsql volatile set search_path = public as $$
begin
  if p_reason not in ('expired', 'cancelled') then
    raise exception 'INVALID_REASON' using errcode = 'P0001';
  end if;
  if p_session_id is null and p_release_token_hash is null then
    raise exception 'NOT_AUTHORIZED' using errcode = 'P0001';
  end if;

  update public.bookings
     set status = p_reason::public.booking_status,
         released_at = now()
   where id = p_booking_id
     and status = 'pending_payment'
     and (p_session_id is null or stripe_checkout_session_id = p_session_id)
     and (p_release_token_hash is null or release_token_hash = p_release_token_hash);
  return found;
end $$;

-- Full refund received from Stripe (charge.refunded with amount_refunded = amount).
create function public.mark_booking_refunded(p_payment_intent text)
returns boolean
language plpgsql volatile set search_path = public as $$
begin
  update public.bookings
     set status = 'refunded', refunded_at = now()
   where stripe_payment_intent_id = p_payment_intent
     and status in ('confirmed', 'needs_review', 'payment_conflict');
  return found;
end $$;

-- Record that a notification e-mail has been delivered (idempotent e-mails).
create function public.mark_booking_email_sent(p_booking_id uuid, p_kind text)
returns boolean
language plpgsql volatile set search_path = public as $$
begin
  if p_kind = 'customer' then
    update public.bookings set customer_email_sent_at = now()
     where id = p_booking_id and customer_email_sent_at is null;
  elsif p_kind = 'studio' then
    update public.bookings set studio_email_sent_at = now()
     where id = p_booking_id and studio_email_sent_at is null;
  else
    raise exception 'INVALID_KIND' using errcode = 'P0001';
  end if;
  return found;
end $$;

-- Safety net, scheduled with pg_cron (see supabase/cron.sql).
create function public.expire_stale_holds()
returns int
language plpgsql volatile set search_path = public as $$
declare
  v_count int;
begin
  update public.bookings
     set status = 'expired', released_at = now()
   where status = 'pending_payment'
     and hold_expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- GDPR: strip technical identifiers from holds that never became bookings.
create function public.purge_stale_hold_data(p_older_than interval default interval '30 days')
returns int
language plpgsql volatile set search_path = public as $$
declare
  v_count int;
begin
  update public.bookings
     set client_ip_hash = null,
         release_token_hash = null,
         customer_name = null,
         customer_email = null,
         customer_phone = null
   where status in ('expired', 'cancelled')
     and coalesce(released_at, updated_at) < now() - p_older_than
     and (client_ip_hash is not null or release_token_hash is not null
          or customer_email is not null);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- Studio view (local times) for the Supabase Table Editor
-- ---------------------------------------------------------------------

create view public.bookings_calendar
with (security_invoker = true) as
select b.reference,
       b.status,
       p.name                                                     as package,
       (b.starts_at at time zone s.timezone)::date               as day,
       to_char(b.starts_at at time zone s.timezone, 'HH24:MI')   as start_local,
       to_char(b.ends_at   at time zone s.timezone, 'HH24:MI')   as end_local,
       b.customer_name,
       b.customer_email,
       b.customer_phone,
       round(coalesce(b.amount_paid_cents, b.price_cents) / 100.0, 2) as amount_eur,
       b.source,
       b.admin_notes,
       b.id
from public.bookings b
join public.packages p on p.id = b.package_id
cross join public.studio_settings s
where b.status in ('confirmed', 'needs_review', 'payment_conflict', 'pending_payment')
order by b.starts_at;

-- ---------------------------------------------------------------------
-- Security: nothing for anon/authenticated, everything via service_role
-- ---------------------------------------------------------------------

alter table public.studio_settings     enable row level security;
alter table public.opening_hours       enable row level security;
alter table public.packages            enable row level security;
alter table public.package_start_times enable row level security;
alter table public.blackout_periods    enable row level security;
alter table public.bookings            enable row level security;
alter table public.stripe_events       enable row level security;

create or replace function pg_temp.mrkll_m1_privileges() returns void language plpgsql as $$
declare
  r text;
  f text;
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    if not has_schema_privilege('service_role', 'public', 'USAGE') then
      grant usage on schema public to service_role; -- already granted on Supabase
    end if;
    grant select, insert, update, delete on public.studio_settings, public.opening_hours, public.packages,
          public.package_start_times, public.blackout_periods, public.bookings, public.stripe_events
          to service_role;
    grant select on public.bookings_calendar to service_role;
  end if;

  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.studio_settings, public.opening_hours, public.packages,
                      public.package_start_times, public.blackout_periods, public.bookings,
                      public.stripe_events, public.bookings_calendar from %I', r);
    end if;
  end loop;

  foreach f in array array[
    'public.touch_updated_at()',
    'public.new_booking_reference()',
    'public.bookings_fill_defaults()',
    'public.slot_is_free(timestamptz, timestamptz, timestamptz)',
    'public.package_slots(text, date, date)',
    'public.get_availability(text, date, date)',
    'public.create_booking_hold(text, date, time, text, text)',
    'public.attach_checkout_session(uuid, text)',
    'public.confirm_booking(uuid, text, text, int, text, text, text, text)',
    'public.release_hold(uuid, text, text, text)',
    'public.mark_booking_refunded(text)',
    'public.mark_booking_email_sent(uuid, text)',
    'public.expire_stale_holds()',
    'public.purge_stale_hold_data(interval)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end $$;
select pg_temp.mrkll_m1_privileges();

commit;
