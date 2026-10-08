-- 이미 schema.sql 을 실행해 둔 프로젝트용: Google 로그인(사용자별 프로젝트)을 위한 열 추가. SQL Editor 에서 한 번 실행하세요.
alter table public.projects  add column if not exists owner uuid;
alter table public.projects  add column if not exists thumb text;
alter table public.usage_log add column if not exists owner uuid;
create index if not exists projects_owner_idx on public.projects (owner, updated_at desc);
