-- =====================================================================
-- MRKLL Studios — Booking system, migration 3 (Phase 2.4: Stripe webhook)
-- Run after 20261111000000_closed_days.sql. Run once.
--
--   * stripe_events      : begin/finish helpers — an event fully processed
--                          once is never processed again.
--   * payment_refunds    : refunds recorded by payment intent, so a refund
--                          arriving BEFORE the payment confirmation is
--                          still applied (out-of-order delivery).
--   * email_notifications: one row per e-mail (unique key). A claim is
--                          required before sending, so duplicated or
--                          concurrent webhooks never send an e-mail twice.
-- =====================================================================

begin;

do $$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'Run migrations 20261110000000 and 20261111000000 first.';
  end if;
  if to_regclass('public.payment_refunds') is not null then
    raise exception 'Migration 3 is already applied (public.payment_refunds exists): skip this file.';
  end if;
end $$;

alter table public.bookings add column conflict_at timestamptz;

comment on column public.bookings.conflict_at is
  'Set when a payment arrived for a slot already taken (automatic refund).';

create table public.payment_refunds (
  payment_intent_id     text primary key,
  charge_id             text,
  amount_cents          int  not null check (amount_cents >= 0),
  amount_refunded_cents int  not null check (amount_refunded_cents >= 0),
  fully_refunded        boolean not null,
  updated_at            timestamptz not null default now()
);

create table public.email_notifications (
  key                 text primary key check (length(key) between 3 and 200),
  booking_id          uuid references public.bookings(id) on delete set null,
  kind                text not null,
  status              text not null check (status in ('sending', 'sent', 'failed', 'abandoned')),
  attempts            int  not null default 1,
  claimed_at          timestamptz not null default now(),
  sent_at             timestamptz,
  provider_message_id text,
  last_error          text,
  created_at          timestamptz not null default now()
);

create index email_notifications_booking_idx on public.email_notifications (booking_id);

comment on table public.email_notifications is
  'Outgoing e-mails. status: sending (claimed), sent, failed (will be retried), abandoned (permanent error).';

-- ---------------------------------------------------------------------
-- Stripe events
-- ---------------------------------------------------------------------

-- Returns 'new' (first delivery), 'retry' (seen, not finished) or 'processed'.
create function public.begin_stripe_event(p_id text, p_type text, p_booking_id uuid)
returns text
language plpgsql volatile set search_path = public as $$
declare
  v_processed timestamptz;
begin
  insert into public.stripe_events (id, type, booking_id)
  values (p_id, p_type, (select b.id from public.bookings b where b.id = p_booking_id))
  on conflict (id) do nothing;
  if found then
    return 'new';
  end if;
  select processed_at into v_processed from public.stripe_events where id = p_id;
  return case when v_processed is null then 'retry' else 'processed' end;
end $$;

create function public.finish_stripe_event(p_id text)
returns void
language sql volatile set search_path = public as $$
  update public.stripe_events set processed_at = coalesce(processed_at, now()) where id = p_id;
$$;

-- ---------------------------------------------------------------------
-- Refunds (any order with respect to the payment confirmation)
-- ---------------------------------------------------------------------

create function public.record_refund(
  p_payment_intent       text,
  p_charge_id            text,
  p_amount_cents         int,
  p_amount_refunded_cents int
)
returns table (booking_id uuid, status public.booking_status, conflict boolean)
language plpgsql volatile set search_path = public as $$
declare
  v_full boolean;
  v_b    public.bookings;
begin
  insert into public.payment_refunds as r (payment_intent_id, charge_id, amount_cents, amount_refunded_cents, fully_refunded)
  values (p_payment_intent, p_charge_id, p_amount_cents, p_amount_refunded_cents,
          p_amount_refunded_cents >= p_amount_cents)
  on conflict (payment_intent_id) do update
     set charge_id             = coalesce(excluded.charge_id, r.charge_id),
         amount_cents          = excluded.amount_cents,
         amount_refunded_cents = greatest(r.amount_refunded_cents, excluded.amount_refunded_cents),
         fully_refunded        = r.fully_refunded
                                 or greatest(r.amount_refunded_cents, excluded.amount_refunded_cents) >= excluded.amount_cents,
         updated_at            = now();

  select fully_refunded into v_full from public.payment_refunds where payment_intent_id = p_payment_intent;

  select * into v_b from public.bookings b where b.stripe_payment_intent_id = p_payment_intent for update;
  if not found then
    return; -- payment not confirmed yet: confirm_booking will apply the refund
  end if;

  if v_full and v_b.status in ('confirmed', 'needs_review', 'payment_conflict') then
    update public.bookings b
       set status = 'refunded', refunded_at = now()
     where b.id = v_b.id
    returning * into v_b;
  end if;

  return query select v_b.id, v_b.status, v_b.conflict_at is not null;
end $$;

-- confirm_booking (same signature as migration 1) now also:
--   * applies a full refund received before the confirmation -> 'refunded'
--   * stamps conflict_at when the slot was taken meanwhile
create or replace function public.confirm_booking(
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
    return 'refunded';
  end if;

  -- Refund already received for this payment (out-of-order events).
  if exists (select 1 from public.payment_refunds r
             where r.payment_intent_id = p_payment_intent and r.fully_refunded) then
    update public.bookings
       set status                     = 'refunded',
           stripe_checkout_session_id = p_session_id,
           stripe_payment_intent_id   = p_payment_intent,
           amount_paid_cents          = p_amount_cents,
           currency_paid              = lower(p_currency),
           customer_name              = nullif(left(p_customer_name, 200), ''),
           customer_email             = nullif(lower(left(p_customer_email, 320)), ''),
           customer_phone             = nullif(left(p_customer_phone, 50), ''),
           hold_expires_at            = null,
           refunded_at                = now()
     where id = p_booking_id;
    return 'refunded';
  end if;

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
    update public.bookings
       set status                     = 'payment_conflict',
           conflict_at                = now(),
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

-- Everything an e-mail needs, with the package and the studio time zone.
create function public.get_booking_details(p_booking_id uuid)
returns table (
  id uuid, reference text, status public.booking_status, package_id text, package_name text,
  duration_minutes int, starts_at timestamptz, ends_at timestamptz, price_cents int,
  amount_paid_cents int, currency text, customer_name text, customer_email text,
  customer_phone text, stripe_checkout_session_id text, stripe_payment_intent_id text,
  conflict_at timestamptz, timezone text
)
language sql stable set search_path = public as $$
  select b.id, b.reference, b.status, b.package_id, p.name, p.duration_minutes, b.starts_at, b.ends_at,
         b.price_cents, b.amount_paid_cents, b.currency, b.customer_name, b.customer_email,
         b.customer_phone, b.stripe_checkout_session_id, b.stripe_payment_intent_id,
         b.conflict_at, s.timezone
  from public.bookings b
  join public.packages p on p.id = b.package_id
  cross join public.studio_settings s
  where b.id = p_booking_id;
$$;

-- ---------------------------------------------------------------------
-- E-mail claims
-- ---------------------------------------------------------------------

-- True when the caller may send this e-mail now. A 'sending' claim older
-- than p_stale_seconds (crashed worker) can be taken over.
create function public.claim_notification(
  p_key text, p_booking_id uuid, p_kind text, p_stale_seconds int default 120
)
returns boolean
language plpgsql volatile set search_path = public as $$
begin
  insert into public.email_notifications as n (key, booking_id, kind, status, attempts, claimed_at)
  values (p_key, (select b.id from public.bookings b where b.id = p_booking_id), p_kind, 'sending', 1, now())
  on conflict (key) do update
     set status = 'sending', attempts = n.attempts + 1, claimed_at = now(), last_error = null
   where n.status = 'failed'
      or (n.status = 'sending' and n.claimed_at < now() - make_interval(secs => p_stale_seconds));
  return found;
end $$;

-- p_outcome: sent | failed (retry later) | abandoned (permanent error)
create function public.complete_notification(
  p_key text, p_outcome text, p_provider_message_id text default null, p_error text default null
)
returns boolean
language plpgsql volatile set search_path = public as $$
declare
  v_n public.email_notifications;
begin
  if p_outcome not in ('sent', 'failed', 'abandoned') then
    raise exception 'INVALID_OUTCOME' using errcode = 'P0001';
  end if;

  update public.email_notifications
     set status              = p_outcome,
         sent_at             = case when p_outcome = 'sent' then now() else sent_at end,
         provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         last_error          = left(p_error, 500)
   where key = p_key and status = 'sending'
  returning * into v_n;
  if not found then
    return false;
  end if;

  -- Keep the booking columns from migration 1 in sync.
  if p_outcome = 'sent' and v_n.booking_id is not null then
    if v_n.kind = 'customer_confirmation' then
      perform public.mark_booking_email_sent(v_n.booking_id, 'customer');
    elsif v_n.kind = 'studio_confirmation' then
      perform public.mark_booking_email_sent(v_n.booking_id, 'studio');
    end if;
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------

alter table public.payment_refunds     enable row level security;
alter table public.email_notifications enable row level security;

do $$
declare
  r text;
  f text;
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.payment_refunds, public.email_notifications to service_role;
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.payment_refunds, public.email_notifications from %I', r);
    end if;
  end loop;

  foreach f in array array[
    'public.begin_stripe_event(text, text, uuid)',
    'public.finish_stripe_event(text)',
    'public.record_refund(text, text, int, int)',
    'public.confirm_booking(uuid, text, text, int, text, text, text, text)',
    'public.get_booking_details(uuid)',
    'public.claim_notification(text, uuid, text, int)',
    'public.complete_notification(text, text, text, text)'
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

commit;
