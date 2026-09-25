package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	webSearchStatsVersion  = 1
	webSearchStatsStateKey = "web_search_stats_revision"
	defaultWebSearchQuery  = "lang:korean -female:snuff -female:gore"
	dotnetUnixEpochTicks   = int64(621355968000000000)
)

type webSearchDateBucket struct {
	Start string `json:"start"`
	End   string `json:"end"`
	Count int    `json:"count"`
}

type webSearchDateDistribution struct {
	MinDate      *string               `json:"minDate"`
	MaxDate      *string               `json:"maxDate"`
	TotalCount   int                   `json:"totalCount"`
	InvalidCount int                   `json:"invalidCount"`
	Unit         string                `json:"unit"`
	Buckets      []webSearchDateBucket `json:"buckets"`
}

type webSearchStatsFile struct {
	Version          int                       `json:"version"`
	Query            string                    `json:"query"`
	Revision         string                    `json:"revision"`
	GeneratedAt      string                    `json:"generatedAt"`
	TotalCount       int                       `json:"totalCount"`
	DateDistribution webSearchDateDistribution `json:"dateDistribution"`
}

func newWebSearchStatsRevision() string {
	return strconv.FormatInt(time.Now().UTC().UnixNano(), 10)
}

func markWebSearchStatsRefreshing(db *sql.DB, revision string) error {
	return setSyncState(db, webSearchStatsStateKey, "syncing:"+revision)
}

func refreshWebSearchStats(db *sql.DB, dbPath, revision string) error {
	started := time.Now()

	totalCount, err := getDefaultWebSearchCount(db)
	if err != nil {
		return fmt.Errorf("count default web search: %w", err)
	}

	distribution, err := getDefaultWebDateDistribution(db)
	if err != nil {
		return fmt.Errorf("build default web date distribution: %w", err)
	}

	value := webSearchStatsFile{
		Version:          webSearchStatsVersion,
		Query:            defaultWebSearchQuery,
		Revision:         revision,
		GeneratedAt:      time.Now().UTC().Format(time.RFC3339Nano),
		TotalCount:       totalCount,
		DateDistribution: distribution,
	}

	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal web search stats: %w", err)
	}

	cachePath := filepath.Join(filepath.Dir(dbPath), "web-search-stats.json")
	tmpPath := cachePath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("write web search stats temp file: %w", err)
	}
	if err := os.Rename(tmpPath, cachePath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("replace web search stats file: %w", err)
	}

	if err := setSyncState(db, webSearchStatsStateKey, revision); err != nil {
		return fmt.Errorf("publish web search stats revision: %w", err)
	}

	log.Printf(
		"Web search stats refreshed in %.1fs: %d results, %d date buckets",
		time.Since(started).Seconds(),
		totalCount,
		len(distribution.Buckets),
	)
	return nil
}

func getDefaultWebSearchCount(db *sql.DB) (int, error) {
	const countSQL = `
WITH blocked AS MATERIALIZED (
	SELECT rowid AS Id
	FROM FtsTags
	WHERE Tags MATCH '"female:snuff" OR "female:gore"'
)
SELECT (
	SELECT COUNT(*)
	FROM HitomiColumnModel
	WHERE ExistOnHitomi=1
	  AND Language='korean'
) + (
	SELECT COUNT(*)
	FROM HitomiColumnModel
	WHERE ExistOnHitomi=0
	  AND Tags LIKE '%|expunged|%'
	  AND Language='korean'
) - (
	SELECT COUNT(*)
	FROM blocked b
	JOIN (
		SELECT Id
		FROM HitomiColumnModel
		WHERE ExistOnHitomi=1
		  AND Language='korean'
	) matched ON matched.Id=b.Id
) AS cnt
`

	var count int
	if err := db.QueryRow(countSQL).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func getDefaultWebDateDistribution(db *sql.DB) (webSearchDateDistribution, error) {
	const baseSQL = `
SELECT Published
FROM HitomiColumnModel
WHERE ExistOnHitomi=1
  AND Language='korean'
UNION ALL
SELECT Published
FROM HitomiColumnModel
WHERE ExistOnHitomi=0
  AND Tags LIKE '%|expunged|%'
  AND Language='korean'
`
	const blockedSQL = `
SELECT h.Published
FROM HitomiColumnModel h
WHERE h.ExistOnHitomi=1
  AND h.Language='korean'
  AND h.Id IN (
	SELECT rowid
	FROM FtsTags
	WHERE Tags MATCH '"female:snuff" OR "female:gore"'
  )
`

	dayCounts := make(map[string]int)
	invalidCount := 0

	if err := applyPublishedRows(db, baseSQL, dayCounts, &invalidCount, 1); err != nil {
		return webSearchDateDistribution{}, err
	}
	if err := applyPublishedRows(db, blockedSQL, dayCounts, &invalidCount, -1); err != nil {
		return webSearchDateDistribution{}, err
	}

	days := make([]string, 0, len(dayCounts))
	totalCount := 0
	for day, count := range dayCounts {
		if count <= 0 {
			continue
		}
		days = append(days, day)
		totalCount += count
	}
	sort.Strings(days)

	result := webSearchDateDistribution{
		TotalCount:   totalCount,
		InvalidCount: invalidCount,
		Unit:         "year",
		Buckets:      []webSearchDateBucket{},
	}
	if len(days) == 0 {
		return result, nil
	}

	minDate := days[0]
	maxDate := days[len(days)-1]
	result.MinDate = &minDate
	result.MaxDate = &maxDate

	minTime, _ := time.Parse("2006-01-02", minDate)
	maxTime, _ := time.Parse("2006-01-02", maxDate)
	spanDays := int(maxTime.Sub(minTime).Hours() / 24)
	if spanDays > 1860 {
		result.Unit = "year"
	} else if spanDays > 45 {
		result.Unit = "month"
	} else {
		result.Unit = "day"
	}

	bucketCounts := make(map[string]int)
	for _, day := range days {
		parsed, _ := time.Parse("2006-01-02", day)
		start := floorWebBucket(parsed, result.Unit)
		bucketCounts[start.Format("2006-01-02")] += dayCounts[day]
	}

	cursor := floorWebBucket(minTime, result.Unit)
	last := floorWebBucket(maxTime, result.Unit)
	for !cursor.After(last) {
		next := addWebBucket(cursor, result.Unit)
		start := cursor.Format("2006-01-02")
		result.Buckets = append(result.Buckets, webSearchDateBucket{
			Start: start,
			End:   next.Format("2006-01-02"),
			Count: bucketCounts[start],
		})
		cursor = next
	}

	return result, nil
}

func applyPublishedRows(
	db *sql.DB,
	query string,
	dayCounts map[string]int,
	invalidCount *int,
	delta int,
) error {
	rows, err := db.Query(query)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var raw any
		if err := rows.Scan(&raw); err != nil {
			return err
		}

		day, ok := normalizePublishedDay(raw)
		if !ok {
			*invalidCount += delta
			continue
		}

		next := dayCounts[day] + delta
		if next <= 0 {
			delete(dayCounts, day)
		} else {
			dayCounts[day] = next
		}
	}
	return rows.Err()
}

func normalizePublishedDay(value any) (string, bool) {
	switch v := value.(type) {
	case int64:
		if v <= dotnetUnixEpochTicks {
			return "", false
		}
		ms := (v - dotnetUnixEpochTicks) / 10_000
		return time.UnixMilli(ms).UTC().Format("2006-01-02"), true
	case float64:
		ticks := int64(v)
		if ticks <= dotnetUnixEpochTicks {
			return "", false
		}
		ms := (ticks - dotnetUnixEpochTicks) / 10_000
		return time.UnixMilli(ms).UTC().Format("2006-01-02"), true
	case string:
		return normalizePublishedString(v)
	case []byte:
		return normalizePublishedString(string(v))
	case time.Time:
		return v.UTC().Format("2006-01-02"), true
	default:
		return "", false
	}
}

func normalizePublishedString(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if len(value) < 10 {
		return "", false
	}
	if len(value) > 10 && value[10] != ' ' && value[10] != 'T' {
		return "", false
	}
	day := value[:10]
	parsed, err := time.Parse("2006-01-02", day)
	if err != nil || parsed.Format("2006-01-02") != day {
		return "", false
	}
	return day, true
}

func floorWebBucket(value time.Time, unit string) time.Time {
	y, m, d := value.Date()
	switch unit {
	case "year":
		return time.Date(y, time.January, 1, 0, 0, 0, 0, time.UTC)
	case "month":
		return time.Date(y, m, 1, 0, 0, 0, 0, time.UTC)
	default:
		return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	}
}

func addWebBucket(value time.Time, unit string) time.Time {
	switch unit {
	case "year":
		return value.AddDate(1, 0, 0)
	case "month":
		return value.AddDate(0, 1, 0)
	default:
		return value.AddDate(0, 0, 1)
	}
}
