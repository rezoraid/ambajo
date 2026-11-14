-- Skema awal Unified Scraper API
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE providers (
  key      text PRIMARY KEY,
  name     text NOT NULL,
  base_url text NOT NULL,
  priority smallint NOT NULL DEFAULT 100
);

CREATE TABLE series (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider          text NOT NULL REFERENCES providers(key) ON UPDATE CASCADE,
  ref               text NOT NULL,                       -- id asli milik provider
  title             text NOT NULL,
  norm_title        text NOT NULL,                       -- judul ternormalisasi (kunci pencocokan antar provider)
  cover             text NOT NULL DEFAULT '',
  url               text NOT NULL DEFAULT '',
  type              text,
  status            text CHECK (status IN ('ongoing', 'completed', 'hiatus')),
  synopsis          text NOT NULL DEFAULT '',
  author            text NOT NULL DEFAULT '',
  artist            text NOT NULL DEFAULT '',
  year              integer,
  rating            double precision,
  chapter_count     integer,
  latest_chapter    text,
  detail_fetched_at timestamptz,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, ref)
);
CREATE INDEX series_norm_title_idx   ON series (norm_title);
CREATE INDEX series_norm_title_trgm  ON series USING gin (norm_title gin_trgm_ops);
CREATE INDEX series_last_seen_idx    ON series (last_seen_at DESC);
CREATE INDEX series_needs_detail_idx ON series (last_seen_at DESC) WHERE detail_fetched_at IS NULL;

CREATE TABLE genres (
  id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE series_genres (
  series_id bigint  NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  genre_id  integer NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (series_id, genre_id)
);
CREATE INDEX series_genres_genre_idx ON series_genres (genre_id, series_id);

CREATE TABLE chapters (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id   bigint NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  ref         text NOT NULL,                             -- ref chapter asli provider
  number      double precision,                          -- untuk pengurutan/pencocokan antar provider
  number_text text NOT NULL,
  title       text NOT NULL DEFAULT '',
  released_at timestamptz,
  UNIQUE (series_id, ref)
);
CREATE INDEX chapters_series_number_idx ON chapters (series_id, number DESC NULLS LAST);
CREATE INDEX chapters_ref_idx ON chapters (ref);

-- Hit detail harian per seri; dasar endpoint /popular
CREATE TABLE series_views (
  series_id bigint  NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  day       date    NOT NULL DEFAULT CURRENT_DATE,
  views     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (series_id, day)
);
CREATE INDEX series_views_day_idx ON series_views (day);
