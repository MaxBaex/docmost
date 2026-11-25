import { Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';

/**
 * Full-text search languages for pages.
 *
 * The page search index (`pages.tsv`) and the search query are built by three
 * SQL helper functions (created by the `search-language-functions` migration):
 *
 *   docmost_page_tsvector(title, body)  -> tsvector  (used by the pages trigger)
 *   docmost_search_tsquery(query)       -> tsquery   (used by SearchService)
 *   docmost_search_config()             -> regconfig (used for ts_headline)
 *
 * With more than one language, the index holds the lexemes of every language
 * and the query matches if any language matches, so e.g. German and English
 * stemming work side by side.
 *
 * `syncSearchLanguages` redefines these helpers when SEARCH_LANGUAGES changes
 * and rebuilds the index of existing pages.
 */

export const DEFAULT_SEARCH_LANGUAGES = ['english'];

const LANGUAGES_COMMENT_PREFIX = 'search_languages=';
const ADVISORY_LOCK_KEY = 7_303_871_442; // arbitrary, unique to this task
const REINDEX_BATCH_SIZE = 500;

// PostgreSQL text search configuration names, e.g. "english", "german", "simple".
const CONFIG_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

export function isValidSearchLanguageName(name: string): boolean {
  return CONFIG_NAME_PATTERN.test(name);
}

/**
 * Parses a comma-separated list such as "german,english".
 * Invalid names are dropped; an empty result falls back to english.
 */
export function parseSearchLanguages(value?: string | null): string[] {
  const languages = (value ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0 && isValidSearchLanguageName(part));

  const unique = [...new Set(languages)];
  return unique.length > 0 ? unique : [...DEFAULT_SEARCH_LANGUAGES];
}

function assertValidLanguages(languages: string[]): void {
  if (languages.length === 0) {
    throw new Error('At least one search language is required');
  }
  for (const language of languages) {
    if (!isValidSearchLanguageName(language)) {
      throw new Error(`Invalid search language: ${language}`);
    }
  }
}

/**
 * SQL that (re)defines the search helper functions for the given languages.
 * Language names are validated against CONFIG_NAME_PATTERN before they are
 * inlined, so they cannot inject SQL.
 */
export function buildSearchFunctionsSql(languages: string[]): string[] {
  assertValidLanguages(languages);

  const vector = (expression: string, weight: 'A' | 'B') =>
    languages
      .map(
        (language) =>
          `setweight(to_tsvector('${language}'::regconfig, ${expression}), '${weight}')`,
      )
      .join(' || ');

  const titleVector = vector(`f_unaccent(coalesce(title, ''))`, 'A');
  const bodyVector = vector(
    `f_unaccent(substring(coalesce(body, ''), 1, 1000000))`,
    'B',
  );
  const query = languages
    .map(
      (language) => `to_tsquery('${language}'::regconfig, f_unaccent(query))`,
    )
    .join(' || ');

  return [
    `CREATE OR REPLACE FUNCTION docmost_page_tsvector(title text, body text)
      RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
        SELECT ${titleVector} || ${bodyVector}
      $$`,
    `CREATE OR REPLACE FUNCTION docmost_search_tsquery(query text)
      RETURNS tsquery LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
        SELECT ${languages.length > 1 ? `(${query})` : query}
      $$`,
    `CREATE OR REPLACE FUNCTION docmost_search_config()
      RETURNS regconfig LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
        SELECT '${languages[0]}'::regconfig
      $$`,
  ];
}

export function buildLanguagesComment(languages: string[]): string {
  assertValidLanguages(languages);
  return LANGUAGES_COMMENT_PREFIX + languages.join(',');
}

export function parseLanguagesComment(comment?: string | null): string[] {
  if (!comment || !comment.startsWith(LANGUAGES_COMMENT_PREFIX)) {
    return [...DEFAULT_SEARCH_LANGUAGES];
  }
  return parseSearchLanguages(comment.slice(LANGUAGES_COMMENT_PREFIX.length));
}

function sameLanguages(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Applies the configured search languages to the database.
 *
 * Does nothing when the languages are unchanged (the default for every
 * existing installation). When they change, the helper functions are
 * redefined and the index of all pages is rebuilt in the background.
 * The new languages are recorded only after the rebuild has finished, so an
 * interrupted rebuild is resumed on the next start.
 */
export async function syncSearchLanguages(
  db: Kysely<any>,
  configured: string[],
  logger: Logger = new Logger('SearchLanguages'),
): Promise<void> {
  const helper = await sql<{ comment: string | null }>`
    SELECT obj_description(p.oid, 'pg_proc') AS comment
    FROM pg_proc p
    WHERE p.proname = 'docmost_page_tsvector'
  `.execute(db);

  if (helper.rows.length === 0) {
    logger.debug('Search helper functions not found, skipping language sync');
    return;
  }

  const known = await sql<{ cfgname: string }>`
    SELECT cfgname FROM pg_ts_config WHERE cfgname = ANY(${configured})
  `.execute(db);
  const knownNames = new Set(known.rows.map((row) => row.cfgname));
  const unknown = configured.filter((language) => !knownNames.has(language));
  if (unknown.length > 0) {
    logger.warn(
      `Ignoring unknown text search configuration(s) in SEARCH_LANGUAGES: ${unknown.join(', ')}`,
    );
  }
  let desired = configured.filter((language) => knownNames.has(language));
  if (desired.length === 0) desired = [...DEFAULT_SEARCH_LANGUAGES];

  const current = parseLanguagesComment(helper.rows[0].comment);
  if (sameLanguages(current, desired)) {
    return;
  }

  // Rebuilding runs in the background so it does not delay start-up.
  void rebuildSearchIndex(db, desired, logger).catch((err) =>
    logger.error(`Rebuilding the page search index failed: ${err}`),
  );
}

async function rebuildSearchIndex(
  db: Kysely<any>,
  languages: string[],
  logger: Logger,
): Promise<void> {
  // A session-level advisory lock needs a dedicated connection.
  await db.connection().execute(async (conn) => {
    const lock = await sql<{ locked: boolean }>`
      SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked
    `.execute(conn);
    if (!lock.rows[0]?.locked) {
      logger.log('Search index rebuild is already running on another instance');
      return;
    }

    try {
      await conn.transaction().execute(async (trx) => {
        for (const statement of buildSearchFunctionsSql(languages)) {
          await sql.raw(statement).execute(trx);
        }
      });

      logger.log(
        `Search languages changed to "${languages.join(', ')}"; rebuilding the page search index`,
      );

      let lastId: string | null = null;
      let total = 0;
      for (;;) {
        const batch = await sql<{ id: string }>`
          WITH batch AS (
            SELECT id FROM pages
            ${lastId ? sql`WHERE id > ${lastId}` : sql``}
            ORDER BY id
            LIMIT ${REINDEX_BATCH_SIZE}
          )
          UPDATE pages
          SET tsv = docmost_page_tsvector(pages.title, pages.text_content)
          FROM batch
          WHERE pages.id = batch.id
          RETURNING pages.id
        `.execute(conn);

        if (batch.rows.length === 0) break;
        total += batch.rows.length;
        lastId = batch.rows.reduce(
          (max, row) => (row.id > max ? row.id : max),
          batch.rows[0].id,
        );
      }

      await sql
        .raw(
          `COMMENT ON FUNCTION docmost_page_tsvector(text, text) IS '${buildLanguagesComment(languages)}'`,
        )
        .execute(conn);

      logger.log(`Page search index rebuilt (${total} pages)`);
    } finally {
      await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`.execute(conn);
    }
  });
}
