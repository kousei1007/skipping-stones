-- 1) 乱数の種を投げた瞬間に記録して、記録時に「投げた瞬間と同じ投げ方か」を確かめられるようにする
--    （これまでは /api/scores が投げ方を自由に変えて何度も送れたので、「5 位以内に入ったか」の成否から
--      サーバーの秘密の乱数を間接的に探れた）
--    この列を追加する前の行は null のまま残る。null の行は従来どおり受け付ける（トークンの期限 12 時間で自然に消える）
alter table public.throw_reveals add column if not exists seed bigint check (seed is null or (seed >= 0 and seed < 4294967296));

-- 2) ブラウザ（anon キー）から読める列を、ランキング表示に必要な列だけにする
--    session_id / throw_index / stone_serial が読めると、他人のプレイの投擲を特定できてしまう
revoke select on public.scores from anon, authenticated;
grant select (id, player_name, stage_id, bounces, distance, weather, created_at) on public.scores to anon, authenticated;
