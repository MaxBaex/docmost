import {
  buildLanguagesComment,
  buildSearchFunctionsSql,
  parseLanguagesComment,
  parseSearchLanguages,
} from './search-languages';

describe('search languages', () => {
  describe('parseSearchLanguages', () => {
    it('defaults to english', () => {
      expect(parseSearchLanguages(undefined)).toEqual(['english']);
      expect(parseSearchLanguages('')).toEqual(['english']);
      expect(parseSearchLanguages(' , ')).toEqual(['english']);
    });

    it('reads a comma-separated list in order', () => {
      expect(parseSearchLanguages('german,english')).toEqual([
        'german',
        'english',
      ]);
    });

    it('normalizes case and whitespace and removes duplicates', () => {
      expect(parseSearchLanguages(' German , ENGLISH,german ')).toEqual([
        'german',
        'english',
      ]);
    });

    it('drops names that are not valid configuration names', () => {
      expect(parseSearchLanguages("german,eng'lish,simple;drop")).toEqual([
        'german',
      ]);
      expect(parseSearchLanguages("x');--")).toEqual(['english']);
    });
  });

  describe('buildSearchFunctionsSql', () => {
    it('uses a single configuration without OR for one language', () => {
      const [vector, query, config] = buildSearchFunctionsSql(['english']);
      expect(vector).toContain(`to_tsvector('english'::regconfig`);
      expect(vector).not.toContain('german');
      expect(query).toContain(
        `SELECT to_tsquery('english'::regconfig, f_unaccent(query))`,
      );
      expect(config).toContain(`SELECT 'english'::regconfig`);
    });

    it('combines every language in the index and the query', () => {
      const [vector, query, config] = buildSearchFunctionsSql([
        'german',
        'english',
      ]);
      expect(vector).toContain(
        `setweight(to_tsvector('german'::regconfig, f_unaccent(coalesce(title, ''))), 'A')`,
      );
      expect(vector).toContain(
        `setweight(to_tsvector('english'::regconfig, f_unaccent(substring(coalesce(body, ''), 1, 1000000))), 'B')`,
      );
      expect(query).toContain(
        `(to_tsquery('german'::regconfig, f_unaccent(query)) || to_tsquery('english'::regconfig, f_unaccent(query)))`,
      );
      // headlines use the first language
      expect(config).toContain(`SELECT 'german'::regconfig`);
    });

    it('refuses invalid names', () => {
      expect(() => buildSearchFunctionsSql([])).toThrow();
      expect(() => buildSearchFunctionsSql(["german'"])).toThrow();
    });
  });

  describe('languages comment', () => {
    it('round-trips', () => {
      const comment = buildLanguagesComment(['german', 'english']);
      expect(comment).toBe('search_languages=german,english');
      expect(parseLanguagesComment(comment)).toEqual(['german', 'english']);
    });

    it('treats a missing or foreign comment as english', () => {
      expect(parseLanguagesComment(null)).toEqual(['english']);
      expect(parseLanguagesComment('something else')).toEqual(['english']);
    });
  });
});
