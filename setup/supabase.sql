-- French app sync: run this once in Supabase > SQL Editor > New query > Run.
-- Data is stored per passphrase (hashed). The table itself is locked; only these two functions can read or write it.

create table if not exists public.french_docs (
  owner text not null,
  name text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner, name)
);

alter table public.french_docs enable row level security;
revoke all on public.french_docs from anon, authenticated;

create or replace function public.french_pull(p_secret text, p_since timestamptz default 'epoch')
returns table (name text, data jsonb, updated_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select d.name, d.data, d.updated_at
  from public.french_docs d
  where d.owner = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
    and d.updated_at > p_since;
$$;

create or replace function public.french_push(p_secret text, p_name text, p_data jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  t timestamptz := clock_timestamp();
begin
  if length(p_secret) < 16 then
    raise exception 'Sync passphrase must be at least 16 characters';
  end if;
  insert into public.french_docs (owner, name, data, updated_at)
  values (encode(sha256(convert_to(p_secret, 'UTF8')), 'hex'), p_name, p_data, t)
  on conflict (owner, name) do update set data = excluded.data, updated_at = excluded.updated_at;
  return t;
end;
$$;

revoke all on function public.french_pull(text, timestamptz) from public;
revoke all on function public.french_push(text, text, jsonb) from public;
grant execute on function public.french_pull(text, timestamptz) to anon;
grant execute on function public.french_push(text, text, jsonb) to anon;
