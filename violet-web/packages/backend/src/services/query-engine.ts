/**
 * Ported from violet/lib/component/query_translate.dart
 * Translates search query DSL to SQL for HitomiColumnModel.
 * Supports FTS5 acceleration when available.
 */

import type { SearchDateRange } from '@violet-web/shared';
import { normalizedPublishedSql, parseDateBounds } from './publication-date.js';

const expungedTagCondition = "Tags LIKE '%|expunged|%'";
const visibleGalleryCondition = `(ExistOnHitomi=1 OR ${expungedTagCondition})`;

type QueryParts = {
  where: string;
  negFts: string;
  applyVisibility: boolean;
};

function translateQueryParts(
  query: string,
  useFts: boolean = false,
): QueryParts {
  query = query.trim();

  // Numeric ID queries intentionally bypass gallery visibility, preserving
  // the legacy direct-lookup behavior.
  const firstToken = query.split(' ')[0];
  const nn = parseInt(firstToken);
  if (!isNaN(nn) && firstToken === String(nn)) {
    return { where: `Id=${nn}`, negFts: '', applyVisibility: false };
  }

  if (query === '') {
    return { where: '1=1', negFts: '', applyVisibility: true };
  }

  const tokens = splitTokens(query)
    .map((x) => x.trim())
    .filter((x) => x !== '');
  const translator = new QueryTranslator(tokens, useFts);
  return {
    where: translator.parseExpression() || '1=1',
    negFts: translator.getNegFtsClause(),
    applyVisibility: true,
  };
}

function canUseVisibleUnion(parts: QueryParts): boolean {
  // Preserve legacy SQL precedence for explicit OR expressions. Simple
  // searches (including the default language + negative-tag query) take the
  // optimized UNION path.
  return parts.applyVisibility && !/\sOR\s/i.test(parts.where);
}

function joinConditions(...conditions: Array<string | undefined>): string {
  const values = conditions.filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.map((value) => `(${value})`).join(' AND ') : '1=1';
}

function buildVisibleSource(
  parts: QueryParts,
  columns: string,
  extraCondition?: string,
): string {
  const base = joinConditions(parts.where, extraCondition);
  return `SELECT ${columns}
FROM HitomiColumnModel
WHERE ${joinConditions(base, 'ExistOnHitomi=1')}
UNION ALL
SELECT ${columns}
FROM HitomiColumnModel
WHERE ${joinConditions(base, 'ExistOnHitomi=0', expungedTagCondition)}`;
}

export function translateQuery(
  query: string,
  page: number,
  pageSize: number,
  useFts: boolean = false,
  dateRange: SearchDateRange = {},
): { sql: string; countSql: string } {
  const parts = translateQueryParts(query, useFts);
  const parsed = parseDateBounds(dateRange.from, dateRange.to);
  const normalized = `(${normalizedPublishedSql('Published')})`;
  const dateCondition = [
    parsed.from ? `${normalized} >= '${parsed.from}'` : '',
    parsed.toExclusive ? `${normalized} < '${parsed.toExclusive}'` : '',
  ].filter(Boolean).join(' AND ');

  if (!canUseVisibleUnion(parts)) {
    const baseCondition = translateQueryCondition(query, useFts);
    const condition = dateCondition
      ? `(${baseCondition}) AND ${dateCondition}`
      : baseCondition;
    return {
      sql: `SELECT * FROM HitomiColumnModel WHERE ${condition} ORDER BY Id DESC LIMIT ${pageSize} OFFSET ${page * pageSize}`,
      countSql: `SELECT COUNT(*) as cnt FROM HitomiColumnModel WHERE ${condition}`,
    };
  }

  const visibleSource = buildVisibleSource(parts, 'Id', dateCondition || undefined);
  const filteredIds = `SELECT Id FROM visible_ids WHERE 1=1${parts.negFts}`;
  return {
    sql: `WITH visible_ids AS NOT MATERIALIZED (
${visibleSource}
),
page_ids AS (
  ${filteredIds}
  ORDER BY Id DESC
  LIMIT ${pageSize} OFFSET ${page * pageSize}
)
SELECT h.*
FROM page_ids p
JOIN HitomiColumnModel h ON h.Id=p.Id
ORDER BY h.Id DESC`,
    countSql: `WITH visible_ids AS NOT MATERIALIZED (
${visibleSource}
)
SELECT COUNT(*) as cnt
FROM visible_ids
WHERE 1=1${parts.negFts}`,
  };
}

export function translateDateDistributionQuery(
  query: string,
  useFts: boolean = false,
): string {
  const parts = translateQueryParts(query, useFts);
  if (!canUseVisibleUnion(parts)) {
    return `SELECT Published FROM HitomiColumnModel WHERE ${translateQueryCondition(query, useFts)}`;
  }

  const visibleSource = buildVisibleSource(parts, 'Id, Published');
  return `WITH visible_dates AS NOT MATERIALIZED (
${visibleSource}
)
SELECT Published
FROM visible_dates
WHERE 1=1${parts.negFts}`;
}

export function translateQueryCondition(
  query: string,
  useFts: boolean = false,
): string {
  const parts = translateQueryParts(query, useFts);
  if (!parts.applyVisibility) return `${parts.where}${parts.negFts}`;
  return `${parts.where}${parts.negFts} AND ${visibleGalleryCondition}`;
}

function splitTokens(input: string): string[] {
  const result: string[] = [];
  let builder = '';

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === ' ') {
      result.push(builder);
      builder = '';
    } else if (ch === '(' || ch === ')') {
      result.push(builder);
      builder = '';
      result.push(ch);
    } else {
      builder += ch;
    }
  }

  result.push(builder);
  return result;
}

class QueryTranslator {
  private tokens: string[];
  private index = 0;
  private useFts: boolean;
  // Batch negative FTS conditions per column to combine into single MATCH with OR
  private negFtsBatch: Map<string, string[]> = new Map();

  constructor(tokens: string[], useFts: boolean = false) {
    this.tokens = tokens;
    this.useFts = useFts;
  }

  /** Combined negative FTS conditions (appended after main WHERE clause) */
  getNegFtsClause(): string {
    if (this.negFtsBatch.size === 0) return '';
    const parts: string[] = [];
    for (const [col, terms] of this.negFtsBatch) {
      if (terms.length === 1) {
        parts.push(`Id NOT IN (SELECT rowid FROM FtsTags WHERE ${col} MATCH '"${terms[0]}"')`);
      } else {
        const matchExpr = terms.map((t) => `"${t}"`).join(' OR ');
        parts.push(`Id NOT IN (SELECT rowid FROM FtsTags WHERE ${col} MATCH '${matchExpr}')`);
      }
    }
    return ' AND ' + parts.join(' AND ');
  }

  parseExpression(): string {
    if (this.index >= this.tokens.length) return '';

    let token = this.nextToken();
    let where = '';
    let negative = false;

    if (token.startsWith('-')) {
      negative = true;
      if (token === '-') {
        token = this.nextToken();
      } else {
        token = token.substring(1);
      }
    }

    if (token.includes(':')) {
      where += this.parseTag(token, negative);
    } else if (
      token.startsWith('page') &&
      (token.includes('>') || token.includes('=') || token.includes('<'))
    ) {
      where += this.parsePageExpression(token);
    } else if (token === '(') {
      where += this.parseParentheses(token, negative);
      where += this.parseExpression();
      where += this.nextToken(); // closing ')'
      if (this.hasMoreTokens()) {
        where += this.parseLogicalExpression();
      }
    } else if (token === ')') {
      return token;
    } else {
      where += this.parseTitle(token, negative);
    }

    if (this.hasMoreTokens() && this.lookAhead() !== ')') {
      where += this.parseLogicalExpression();
    }

    return where;
  }

  private parseTag(token: string, negative: boolean): string {
    const ss = token.split(':');
    const prefix = ss[0];
    const column = findColumnByTag(prefix);
    if (column === '') return '';

    // Single-value columns: use exact match (works with B-tree index)
    if (column === 'Language' || column === 'Type') {
      const value = escapeSql(ss[1].replace(/_/g, ' '));
      return negative
        ? `(${column} = '${value}') IS NOT 1`
        : `${column} = '${value}'`;
    }

    if (column === 'Uploader') {
      const value = escapeSql(ss[1]);
      return negative
        ? `(Uploader = '${value}' COLLATE NOCASE) IS NOT 1`
        : `Uploader = '${value}' COLLATE NOCASE`;
    }

    // Pipe-delimited columns: FTS5 or LIKE
    if (this.useFts && column !== 'Class') {
      let searchTerm: string;
      switch (prefix) {
        case 'male':
        case 'female':
          // Include namespace: male:shotacon → male:shotacon
          searchTerm = token.replace(/ /g, '_');
          break;
        default:
          // Strip prefix: artist:some_name → some_name
          searchTerm = ss[1].replace(/ /g, '_');
          break;
      }

      const ftsColumn = column === 'Groups' ? 'Groups_' : column;
      const escaped = escapeFts5(searchTerm);

      if (negative) {
        // Batch negatives per column → combined into single MATCH with OR
        const terms = this.negFtsBatch.get(ftsColumn) || [];
        terms.push(escaped);
        this.negFtsBatch.set(ftsColumn, terms);
        return '1=1';
      }
      return `Id IN (SELECT rowid FROM FtsTags WHERE ${ftsColumn} MATCH '"${escaped}"')`;
    }

    // Title FTS handled in parseTitle, so this branch is for
    // Class and LIKE fallback for pipe-delimited columns
    let name = '';
    switch (prefix) {
      case 'male':
      case 'female':
        name = `|${token.replace(/_/g, ' ')}|`;
        break;
      case 'tag':
      case 'series':
      case 'artist':
      case 'character':
      case 'group':
        name = `|${ss[1].replace(/_/g, ' ')}|`;
        break;
      case 'uploader':
        name = ss[1];
        break;
      case 'lang':
      case 'type':
      case 'class':
        name = ss[1].replace(/_/g, ' ');
        break;
    }

    let compare = `${column} LIKE '%${escapeSql(name)}%'`;
    if (column === 'Uploader') compare += ' COLLATE NOCASE';

    return negative ? `(${compare}) IS NOT 1` : compare;
  }

  private parsePageExpression(token: string): string {
    const re = /page([\=\<\>]{1,2})(\d+)/;
    const match = token.match(re);
    if (match) {
      return `Files ${match[1]} ${match[2]}`;
    }
    return '';
  }

  private parseParentheses(token: string, negative: boolean): string {
    return negative ? `NOT ${token}` : token;
  }

  private parseTitle(token: string, negative: boolean): string {
    // FTS5 trigram: true substring matching (min 3 chars)
    if (this.useFts && token.length >= 3) {
      const escaped = escapeFts5(token);
      return negative
        ? `Id NOT IN (SELECT rowid FROM FtsTitle WHERE FtsTitle MATCH '"${escaped}"')`
        : `Id IN (SELECT rowid FROM FtsTitle WHERE FtsTitle MATCH '"${escaped}"')`;
    }
    // Fallback: LIKE
    const escaped = escapeSql(token);
    return negative
      ? `Title NOT LIKE '%${escaped}%'`
      : `Title LIKE '%${escaped}%'`;
  }

  private parseLogicalExpression(): string {
    const next = this.lookAhead();
    let op: string;
    if (next.toLowerCase() === 'or') {
      this.nextToken();
      op = 'OR';
    } else {
      op = 'AND';
    }
    return ` ${op} ${this.parseExpression()}`;
  }

  private nextToken(): string {
    return this.tokens[this.index++];
  }

  private lookAhead(): string {
    return this.index < this.tokens.length ? this.tokens[this.index] : '';
  }

  private hasMoreTokens(): boolean {
    return this.index < this.tokens.length;
  }
}

function findColumnByTag(tag: string): string {
  switch (tag) {
    case 'male':
    case 'female':
    case 'tag':
      return 'Tags';
    case 'lang':
      return 'Language';
    case 'series':
      return 'Series';
    case 'artist':
      return 'Artists';
    case 'group':
      return 'Groups';
    case 'uploader':
      return 'Uploader';
    case 'character':
      return 'Characters';
    case 'type':
      return 'Type';
    case 'class':
      return 'Class';
    default:
      return tag;
  }
}

function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}

function escapeFts5(str: string): string {
  return str.replace(/"/g, '""');
}
