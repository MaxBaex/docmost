import { type Kysely, sql } from 'kysely';

// Moves the page search language out of the pages trigger into helper
// functions, so it can be configured with SEARCH_LANGUAGES.
// The helpers are created for english, which produces exactly the same
// index as before; no reindex is needed here.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION docmost_page_tsvector(title text, body text)
      RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
        SELECT setweight(to_tsvector('english'::regconfig, f_unaccent(coalesce(title, ''))), 'A')
            || setweight(to_tsvector('english'::regconfig, f_unaccent(substring(coalesce(body, ''), 1, 1000000))), 'B')
      $$;
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION docmost_search_tsquery(query text)
      RETURNS tsquery LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
        SELECT to_tsquery('english'::regconfig, f_unaccent(query))
      $$;
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION docmost_search_config()
      RETURNS regconfig LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
        SELECT 'english'::regconfig
      $$;
  `.execute(db);

  await sql`
    COMMENT ON FUNCTION docmost_page_tsvector(text, text) IS 'search_languages=english'
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION pages_tsvector_trigger() RETURNS trigger AS $$
    begin
        if tg_op = 'UPDATE'
            and old.title is not distinct from new.title
            and old.text_content is not distinct from new.text_content then
            return new;
        end if;
        new.tsv := docmost_page_tsvector(new.title, new.text_content);
        return new;
    end;
    $$ LANGUAGE plpgsql;
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION pages_tsvector_trigger() RETURNS trigger AS $$
    begin
        if tg_op = 'UPDATE'
            and old.title is not distinct from new.title
            and old.text_content is not distinct from new.text_content then
            return new;
        end if;
        new.tsv :=
                  setweight(to_tsvector('english', f_unaccent(coalesce(new.title, ''))), 'A') ||
                  setweight(to_tsvector('english', f_unaccent(substring(coalesce(new.text_content, ''), 1, 1000000))), 'B');
        return new;
    end;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  // The index may have been built for other languages; rebuild it for english.
  await sql`
    UPDATE pages SET tsv =
      setweight(to_tsvector('english', f_unaccent(coalesce(title, ''))), 'A') ||
      setweight(to_tsvector('english', f_unaccent(substring(coalesce(text_content, ''), 1, 1000000))), 'B')
  `.execute(db);

  await sql`DROP FUNCTION IF EXISTS docmost_search_config()`.execute(db);
  await sql`DROP FUNCTION IF EXISTS docmost_search_tsquery(text)`.execute(db);
  await sql`DROP FUNCTION IF EXISTS docmost_page_tsvector(text, text)`.execute(
    db,
  );
}
