-- myExpenses — Supabase schema (schema "myexpenses" in OneDB)
-- 1. Run OneDB/platform.sql first (shared profiles + helpers such as touch_updated_at).
-- 2. Run this file in Supabase Dashboard → SQL Editor. Safe to re-run (also upgrades older versions of this schema).
-- 3. Add "myexpenses" under Project Settings → Data API → Exposed schemas.

create schema if not exists myexpenses;
grant usage on schema myexpenses to anon, authenticated, service_role;

-- Move tables made by the older version of this file (which used the public schema).
do $$
declare t text;
begin
  foreach t in array array['expense_lists', 'list_members', 'expenses'] loop
    if to_regclass('public.' || t) is not null and to_regclass('myexpenses.' || t) is null then
      execute format('alter table public.%I set schema myexpenses', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Expense lists ("My Daily Expenses", "Credit Card", "Goa Trip", ...)
-- ---------------------------------------------------------------------------
create table if not exists myexpenses.expense_lists (
  id          uuid primary key,                     -- generated on the client so offline rows keep their id
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade, -- owner
  name        text not null check (char_length(name) between 1 and 80),
  kind        text not null default 'general',      -- general (Daily) | trip | credit_card | personal | home | other
  favorite    boolean not null default false,       -- shown under "Quick access" on the owner's home screen
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false         -- soft delete so offline devices learn about deletions
);

create index if not exists expense_lists_user_updated_at_idx on myexpenses.expense_lists (user_id, updated_at);

drop trigger if exists expense_lists_touch_updated_at on myexpenses.expense_lists;
create trigger expense_lists_touch_updated_at
  before insert or update on myexpenses.expense_lists
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Sharing: who a list is shared with (by Google email) and what they may do.
--   view → can see the list and its entries
--   edit → can also add entries (and edit/delete the entries they added)
-- ---------------------------------------------------------------------------
create table if not exists myexpenses.list_members (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade, -- list owner who shared it
  list_id     uuid not null references myexpenses.expense_lists (id) on delete cascade,
  email       text not null check (email = lower(email) and position('@' in email) > 1),
  role        text not null default 'view' check (role in ('view', 'edit')),
  owner_name  text not null default '',            -- shown to the friend as "Shared by …"
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false        -- soft delete = access removed (friends' devices learn about it)
);

create unique index if not exists list_members_list_email_idx on myexpenses.list_members (list_id, email);
create index if not exists list_members_email_idx on myexpenses.list_members (email);
create index if not exists list_members_updated_at_idx on myexpenses.list_members (updated_at);

drop trigger if exists list_members_touch_updated_at on myexpenses.list_members;
create trigger list_members_touch_updated_at
  before insert or update on myexpenses.list_members
  for each row execute function public.touch_updated_at();

-- The current user's access to a list: 'owner', 'edit', 'view' or null.
-- SECURITY DEFINER so policies can call it without recursing through each other's RLS.
create or replace function myexpenses.list_role(p_list uuid)
returns text language sql stable security definer set search_path = myexpenses as $$
  select case
    when exists (select 1 from myexpenses.expense_lists l where l.id = p_list and l.user_id = auth.uid()) then 'owner'
    else (
      select m.role from myexpenses.list_members m
      where m.list_id = p_list and m.email = lower(auth.jwt() ->> 'email') and not m.deleted
      limit 1
    )
  end
$$;

-- ---------------------------------------------------------------------------
-- Entries inside a list
-- ---------------------------------------------------------------------------
create table if not exists myexpenses.expenses (
  id           uuid primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade, -- who added it
  list_id      uuid references myexpenses.expense_lists (id) on delete cascade,
  direction    text not null default 'debit' check (direction in ('debit', 'credit')), -- debit = money out (−), credit = money in (+)
  kind         text not null default 'entry' check (kind in ('entry', 'note')), -- note = a text row in the list (no money)
  amount       numeric(12, 2) not null check (amount >= 0),             -- notes may have 0 (no amount)
  category     text not null,
  purpose      text not null default '',            -- what it was for (main text in the list)
  note         text not null default '',            -- optional extra details
  pay_via      text not null default '',            -- Cash | UPI | Card | Net banking | Wallet | Other
  paid_by      text not null default '',            -- who paid / received it
  spend_type   text not null default '' check (spend_type in ('', 'need', 'want', 'saving')), -- expense type of a spent entry ('' = not set)
  spent_on     date not null default current_date,
  spent_time   text not null default '',            -- 'HH:MM' local time ('' for old entries → created_at is used)
  author_name  text not null default '',            -- shown on shared lists as "by …"
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted      boolean not null default false,
  favorite     boolean not null default false         -- legacy (favourites moved to lists); kept for compatibility
);

-- Upgrades for tables created by earlier versions of this file.
alter table myexpenses.expenses add column if not exists favorite boolean not null default false;
alter table myexpenses.expenses add column if not exists list_id uuid references myexpenses.expense_lists (id) on delete cascade;
alter table myexpenses.expenses add column if not exists direction text not null default 'debit' check (direction in ('debit', 'credit'));
alter table myexpenses.expenses add column if not exists author_name text not null default '';
alter table myexpenses.expenses add column if not exists purpose text not null default '';
alter table myexpenses.expenses add column if not exists pay_via text not null default '';
alter table myexpenses.expenses add column if not exists paid_by text not null default '';
alter table myexpenses.expenses add column if not exists spend_type text not null default '' check (spend_type in ('', 'need', 'want', 'saving'));
alter table myexpenses.expenses add column if not exists spent_time text not null default '';
-- Notes: a kind column, and amount 0 allowed (a note without an amount).
alter table myexpenses.expenses add column if not exists kind text not null default 'entry' check (kind in ('entry', 'note'));
alter table myexpenses.expenses drop constraint if exists expenses_amount_check;
alter table myexpenses.expenses add constraint expenses_amount_check check (amount >= 0);

create index if not exists expenses_user_spent_on_idx on myexpenses.expenses (user_id, spent_on desc);
create index if not exists expenses_user_updated_at_idx on myexpenses.expenses (user_id, updated_at);
create index if not exists expenses_list_idx on myexpenses.expenses (list_id);
create index if not exists expenses_updated_at_idx on myexpenses.expenses (updated_at);

drop trigger if exists expenses_touch_updated_at on myexpenses.expenses;
create trigger expenses_touch_updated_at
  before insert or update on myexpenses.expenses
  for each row execute function public.touch_updated_at();

grant select, insert, update, delete on all tables in schema myexpenses to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table myexpenses.expense_lists enable row level security;
alter table myexpenses.list_members enable row level security;
alter table myexpenses.expenses enable row level security;

-- Lists: owners do everything; people it's shared with can read it.
drop policy if exists "expense_lists_select_own" on myexpenses.expense_lists;
drop policy if exists "expense_lists_select" on myexpenses.expense_lists;
create policy "expense_lists_select" on myexpenses.expense_lists
  for select using (auth.uid() = user_id or myexpenses.list_role(id) in ('view', 'edit'));

drop policy if exists "expense_lists_insert_own" on myexpenses.expense_lists;
create policy "expense_lists_insert_own" on myexpenses.expense_lists
  for insert with check (auth.uid() = user_id);

drop policy if exists "expense_lists_update_own" on myexpenses.expense_lists;
create policy "expense_lists_update_own" on myexpenses.expense_lists
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "expense_lists_delete_own" on myexpenses.expense_lists;
create policy "expense_lists_delete_own" on myexpenses.expense_lists
  for delete using (auth.uid() = user_id);

-- Members: the list owner manages them; a friend can see their own membership rows.
drop policy if exists "list_members_select" on myexpenses.list_members;
create policy "list_members_select" on myexpenses.list_members
  for select using (auth.uid() = user_id or email = lower(auth.jwt() ->> 'email'));

drop policy if exists "list_members_insert" on myexpenses.list_members;
create policy "list_members_insert" on myexpenses.list_members
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from myexpenses.expense_lists l where l.id = list_id and l.user_id = auth.uid())
  );

drop policy if exists "list_members_update" on myexpenses.list_members;
create policy "list_members_update" on myexpenses.list_members
  for update using (auth.uid() = user_id) with check (
    auth.uid() = user_id
    and exists (select 1 from myexpenses.expense_lists l where l.id = list_id and l.user_id = auth.uid())
  );

drop policy if exists "list_members_delete" on myexpenses.list_members;
create policy "list_members_delete" on myexpenses.list_members
  for delete using (auth.uid() = user_id);

-- Entries: readable by anyone with access to the list; added by the owner or editors;
-- each person edits/deletes only the entries they added.
drop policy if exists "expenses_select_own" on myexpenses.expenses;
drop policy if exists "expenses_select" on myexpenses.expenses;
create policy "expenses_select" on myexpenses.expenses
  for select using (auth.uid() = user_id or myexpenses.list_role(list_id) is not null);

drop policy if exists "expenses_insert_own" on myexpenses.expenses;
create policy "expenses_insert_own" on myexpenses.expenses
  for insert with check (
    auth.uid() = user_id and (list_id is null or myexpenses.list_role(list_id) in ('owner', 'edit'))
  );

drop policy if exists "expenses_update_own" on myexpenses.expenses;
create policy "expenses_update_own" on myexpenses.expenses
  for update using (auth.uid() = user_id) with check (
    auth.uid() = user_id and (list_id is null or myexpenses.list_role(list_id) in ('owner', 'edit'))
  );

drop policy if exists "expenses_delete_own" on myexpenses.expenses;
create policy "expenses_delete_own" on myexpenses.expenses
  for delete using (auth.uid() = user_id);

-- Functions are callable by signed-in users only (list_role is used inside the policies above).
revoke execute on all functions in schema myexpenses from public, anon;
grant execute on all functions in schema myexpenses to authenticated, service_role;

-- Leftover from the older public-schema version (its policies were moved with the tables).
drop function if exists public.list_role(uuid);
