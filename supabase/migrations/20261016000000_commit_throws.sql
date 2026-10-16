-- 投擲の結果は乱数を明かす時点（/api/stone-luck）で確定させて保存し、記録（/api/scores）はその結果だけを使う。
-- これで外れた投擲を「なかったこと」にして引き直すことができなくなる

-- プレイ（/api/session で発行）ごとの状態。投擲番号は前にしか進まず、前の投擲が飛び終わるまで次を受け付けない
create table if not exists public.play_sessions (
  id uuid primary key,
  stage_id text not null,
  ip_hash text not null,
  last_throw_index integer not null default -1,
  next_throw_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists play_sessions_ip_time_idx on public.play_sessions (ip_hash, created_at);

-- ブラウザ（anon キー）からは読み書きできない（ポリシーなし）
alter table public.play_sessions enable row level security;

-- 乱数を明かした投擲の内容と結果
alter table public.throw_reveals add column if not exists stone_serial integer check (stone_serial >= 0);
alter table public.throw_reveals add column if not exists bounces integer check (bounces >= 0);
alter table public.throw_reveals add column if not exists distance real;
alter table public.throw_reveals add column if not exists weather text;
alter table public.throw_reveals add column if not exists end_t real;
alter table public.throw_reveals add column if not exists ip_hash text;

-- 同じプレイで同じ石は 1 回しか投げられない
create unique index if not exists throw_reveals_session_stone_uniq on public.throw_reveals (session_id, stone_serial);
create index if not exists throw_reveals_ip_time_idx on public.throw_reveals (ip_hash, created_at);

-- プレイを発行する。同じ接続元の数を数えてから追加するまでをロックの中で行う（同時に送っても上限を超えない）
create or replace function public.open_play_session(p_id uuid, p_stage_id text, p_ip_hash text, p_limit integer, p_window_s integer)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  recent integer;
begin
  perform pg_advisory_xact_lock(hashtext('play_sessions:' || p_ip_hash));
  select count(*) into recent from play_sessions where ip_hash = p_ip_hash and created_at >= now() - make_interval(secs => p_window_s);
  if recent >= p_limit then
    return false;
  end if;
  insert into play_sessions (id, stage_id, ip_hash) values (p_id, p_stage_id, p_ip_hash);
  return true;
end;
$$;

-- 投擲を確定させる。結果は呼び出し側（サーバー）が計算して渡す。
-- 戻り値: ok / no-session / too-soon / bad-index / rate-limited / stone-used
-- 回数制限で断るときも投擲番号は進める（ブラウザ側の番号とずれないように）。
-- 断った投擲はブラウザでは別の乱数で飛ぶので、次の投擲までの間隔は飛行時間を足さない最短の間隔にする
create or replace function public.reveal_throw(
  p_session_id uuid,
  p_throw_index integer,
  p_max_skip integer,
  p_min_gap_s real,
  p_ip_hash text,
  p_ip_limit integer,
  p_stone_serial integer,
  p_bounces integer,
  p_distance real,
  p_weather text,
  p_end_t real
)
returns text
language plpgsql
set search_path = public
as $$
declare
  s play_sessions%rowtype;
  recent integer;
begin
  select * into s from play_sessions where id = p_session_id for update;
  if not found then
    return 'no-session';
  end if;
  if s.next_throw_at > now() then
    return 'too-soon';
  end if;
  if p_throw_index <= s.last_throw_index or p_throw_index > s.last_throw_index + 1 + p_max_skip then
    return 'bad-index';
  end if;
  update play_sessions
    set last_throw_index = p_throw_index, next_throw_at = now() + make_interval(secs => p_min_gap_s)
    where id = p_session_id;

  perform pg_advisory_xact_lock(hashtext('throw_reveals:' || p_ip_hash));
  select count(*) into recent from throw_reveals where ip_hash = p_ip_hash and created_at >= now() - interval '1 minute';
  if recent >= p_ip_limit then
    return 'rate-limited';
  end if;

  begin
    insert into throw_reveals (session_id, throw_index, stone_serial, bounces, distance, weather, end_t, ip_hash)
      values (p_session_id, p_throw_index, p_stone_serial, p_bounces, p_distance, p_weather, p_end_t, p_ip_hash);
  exception when unique_violation then
    return 'stone-used';
  end;
  update play_sessions set next_throw_at = now() + make_interval(secs => p_end_t + p_min_gap_s) where id = p_session_id;
  return 'ok';
end;
$$;

-- この 2 つの関数はサーバー（service_role）だけが呼べる
revoke execute on function public.open_play_session(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.reveal_throw(uuid, integer, integer, real, text, integer, integer, integer, real, text, real) from public, anon, authenticated;
grant execute on function public.open_play_session(uuid, text, text, integer, integer) to service_role;
grant execute on function public.reveal_throw(uuid, integer, integer, real, text, integer, integer, integer, real, text, real) to service_role;

-- ランキングの閲覧は表示に使う列だけにする（session_id・stone_serial などは見せない）
revoke select on public.scores from anon, authenticated;
grant select (id, player_name, stage_id, bounces, distance, weather, created_at) on public.scores to anon, authenticated;
