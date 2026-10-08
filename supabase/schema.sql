-- Supabase 대시보드 → SQL Editor 에 붙여 넣어 한 번 실행하세요.
-- RLS 를 켜고 정책을 만들지 않으므로 anon/로그인 사용자는 접근할 수 없고, 서버의 service_role 키만 읽고 씁니다.

create table if not exists public.projects (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid,                       -- 로그인한 사용자 id (Supabase Auth). 비어 있으면 공용
  title      text not null default '새 무빙툰',
  thumb      text,                       -- 목록 미리보기용 작은 JPEG(data URL)
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists projects_updated_idx on public.projects (updated_at desc);

create table if not exists public.usage_log (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  owner      uuid,
  project_id uuid,
  kind       text,
  provider   text,
  ok         boolean not null default false,
  cost       numeric(10,4) not null default 0,
  ms         integer,
  error      text
);
create index if not exists usage_log_created_idx on public.usage_log (created_at desc);

alter table public.projects  enable row level security;
alter table public.usage_log enable row level security;

-- 이미지·영상·음성 파일용 비공개 버킷
insert into storage.buckets (id, name, public) values ('studio', 'studio', false) on conflict (id) do nothing;
