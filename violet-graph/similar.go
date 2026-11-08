package main

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type similarOptions struct {
	inputPath      string
	outputPath     string
	query          string
	expand         string
	showQueryTerms bool
	topN           int
	minCooccur     int
	autoMinCooccur bool
	minKeywordDF   int
}

type similarResult struct {
	Query      string
	QueryTerms string
	Keyword    string
	Score      float64
	Cooccur    int
	QueryDF    int
	KeywordDF  int
}

type similarAccumulator struct {
	rawScore float64
	cooccur  int
}

type keywordIndex struct {
	works        map[string]map[string]*keywordRow
	keywordWorks map[string][]*keywordRow
	actualDF     map[string]int
}

func runSimilar(args []string) error {
	opts := parseSimilarFlags(args)
	rows, err := readKeywordCSV(opts.inputPath)
	if err != nil {
		return err
	}
	results := findSimilarKeywords(rows, opts)
	if opts.outputPath == "" {
		return writeSimilarRows(results, os.Stdout, opts.showQueryTerms)
	}
	if err := writeSimilarCSV(results, opts.outputPath, opts.showQueryTerms); err != nil {
		return err
	}
	fmt.Printf("query=%s similar_rows=%d output=%s\n", opts.query, len(results), opts.outputPath)
	return nil
}

func parseSimilarFlags(args []string) similarOptions {
	var opts similarOptions
	flags := flag.NewFlagSet("similar", flag.ExitOnError)
	flags.StringVar(&opts.inputPath, "input", filepath.Join("..", "..", "artifacts", "dialogue-explore", "work-keywords-go.csv"), "Keyword CSV from extract.")
	flags.StringVar(&opts.outputPath, "output", "", "Optional CSV output path. Defaults to stdout.")
	flags.StringVar(&opts.query, "query", "", "Keyword to search similar terms for.")
	flags.StringVar(&opts.expand, "expand", "none", "Query expansion mode: none or contains.")
	flags.BoolVar(&opts.showQueryTerms, "show-query-terms", false, "Include expanded query terms in CSV output.")
	flags.IntVar(&opts.topN, "top-n", 30, "Number of similar keywords to output.")
	flags.IntVar(&opts.minCooccur, "min-cooccur", 5, "Minimum number of shared works.")
	flags.BoolVar(&opts.autoMinCooccur, "auto-min-cooccur", false, "Raise min cooccur automatically for broad query keywords.")
	flags.IntVar(&opts.minKeywordDF, "min-keyword-df", 5, "Minimum keyword document frequency.")
	flags.Parse(args)

	if opts.query == "" && flags.NArg() > 0 {
		opts.query = flags.Arg(0)
	}
	opts.query = strings.TrimSpace(opts.query)
	if opts.query == "" {
		fatal(fmt.Errorf("similar requires --query or a positional query keyword"))
	}
	if opts.expand != "none" && opts.expand != "contains" {
		fatal(fmt.Errorf("--expand must be none or contains"))
	}
	if opts.topN < 1 {
		fatal(fmt.Errorf("--top-n must be >= 1"))
	}
	if opts.minCooccur < 1 {
		fatal(fmt.Errorf("--min-cooccur must be >= 1"))
	}
	if opts.minKeywordDF < 1 {
		fatal(fmt.Errorf("--min-keyword-df must be >= 1"))
	}
	return opts
}

func readKeywordCSV(inputPath string) ([]keywordRow, error) {
	file, err := os.Open(inputPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	// Count physical lines before parsing so the large keywordRow backing
	// array can be allocated only once. Extra lines inside quoted CSV fields
	// may overestimate capacity but cannot change parsed results.
	buf := make([]byte, 1<<20)
	lineCount := 0
	lastWasNewline := false
	hasData := false
	for {
		n, readErr := file.Read(buf)
		if n > 0 {
			hasData = true
			lastWasNewline = buf[n-1] == '\n'
			lineCount += bytes.Count(buf[:n], []byte{'\n'})
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, readErr
		}
	}
	if hasData && !lastWasNewline {
		lineCount++
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	rowCapacity := lineCount - 1 // Exclude CSV header.
	if rowCapacity < 0 {
		rowCapacity = 0
	}
	reader := csv.NewReader(bufio.NewReaderSize(file, 1<<20))
	reader.FieldsPerRecord = -1
	reader.ReuseRecord = true
	header, err := reader.Read()
	if err != nil {
		return nil, err
	}
	index := make(map[string]int, len(header))
	for i, name := range header {
		index[strings.TrimPrefix(name, "\ufeff")] = i
	}

	// Intern repeated work IDs and keywords, and detach retained strings from
	// CSV record buffers (whose numeric fields otherwise stay in memory too).
	interned := make(map[string]string)
	intern := func(value string) string {
		if shared, ok := interned[value]; ok {
			return shared
		}
		shared := strings.Clone(value)
		interned[shared] = shared
		return shared
	}

	rows := make([]keywordRow, 0, rowCapacity)
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		row := keywordRow{
			ArticleID:      intern(getCSVField(record, index, "article_id")),
			Keyword:        intern(getCSVField(record, index, "keyword")),
			Rank:           parseCSVInt(record, index, "rank"),
			TF:             parseCSVInt(record, index, "tf"),
			DF:             parseCSVInt(record, index, "df"),
			Score:          parseCSVFloat(record, index, "score"),
			TotalPages:     parseCSVInt(record, index, "total_pages"),
			DialogueCount:  parseCSVInt(record, index, "dialogue_count"),
			CharacterCount: parseCSVInt(record, index, "char_count"),
		}
		if row.ArticleID == "" || row.Keyword == "" {
			continue
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func findSimilarKeywords(rows []keywordRow, opts similarOptions) []similarResult {
	return findSimilarKeywordsFromIndex(newKeywordIndex(rows), opts)
}

func newKeywordIndex(rows []keywordRow) keywordIndex {
	works := make(map[string]map[string]*keywordRow)
	for i := range rows {
		row := &rows[i]
		if row.Keyword == "" || row.ArticleID == "" {
			continue
		}
		workRows := works[row.ArticleID]
		if workRows == nil {
			workRows = make(map[string]*keywordRow)
			works[row.ArticleID] = workRows
		}
		old, exists := workRows[row.Keyword]
		if !exists || keywordWeight(*row) > keywordWeight(*old) {
			workRows[row.Keyword] = row
		}
	}

	// An inverted list is substantially smaller than a map for every
	// (keyword, work) pair. Keep O(1) work/keyword lookups in works instead.
	actualDF := make(map[string]int)
	for _, workRows := range works {
		for keyword := range workRows {
			actualDF[keyword]++
		}
	}
	keywordWorks := make(map[string][]*keywordRow, len(actualDF))
	for keyword, count := range actualDF {
		keywordWorks[keyword] = make([]*keywordRow, 0, count)
	}
	for _, workRows := range works {
		for keyword, row := range workRows {
			keywordWorks[keyword] = append(keywordWorks[keyword], row)
		}
	}
	return keywordIndex{
		works:        works,
		keywordWorks: keywordWorks,
		actualDF:     actualDF,
	}
}

func findSimilarKeywordsFromIndex(index keywordIndex, opts similarOptions) []similarResult {
	if opts.topN < 1 {
		opts.topN = 30
	}
	if opts.autoMinCooccur {
		if opts.minCooccur < 0 {
			opts.minCooccur = 0
		}
	} else if opts.minCooccur < 1 {
		opts.minCooccur = 1
	}
	if opts.minKeywordDF < 1 {
		opts.minKeywordDF = 1
	}

	queryTerms := resolveQueryTerms(opts.query, opts.expand, index.actualDF)
	if len(queryTerms) == 0 {
		return nil
	}
	queryTermSet := make(map[string]struct{}, len(queryTerms))
	for _, term := range queryTerms {
		queryTermSet[term] = struct{}{}
	}
	queryTermsText := strings.Join(queryTerms, "|")

	queryWorks := make(map[string]float64)
	for _, term := range queryTerms {
		for _, row := range index.keywordWorks[term] {
			articleID := row.ArticleID
			weight := keywordWeight(*row)
			if old, exists := queryWorks[articleID]; !exists || weight > old {
				queryWorks[articleID] = weight
			}
		}
	}

	accumulators := make(map[string]*similarAccumulator)
	queryDF := len(queryWorks)
	for articleID, queryWeight := range queryWorks {
		workRows := index.works[articleID]
		for keyword, row := range workRows {
			if _, isQueryTerm := queryTermSet[keyword]; isQueryTerm {
				continue
			}
			acc := accumulators[keyword]
			if acc == nil {
				acc = &similarAccumulator{}
				accumulators[keyword] = acc
			}
			acc.cooccur++
			acc.rawScore += queryWeight * keywordWeight(*row)
		}
	}

	results := make([]similarResult, 0, len(accumulators))
	effectiveMinCooccur := adaptiveMinCooccurThreshold(opts, queryDF, accumulators, index.actualDF)
	for keyword, acc := range accumulators {
		keywordDF := index.actualDF[keyword]
		if keywordDF < opts.minKeywordDF || acc.cooccur < effectiveMinCooccur {
			continue
		}
		score := acc.rawScore / math.Sqrt(float64(queryDF*keywordDF))
		results = append(results, similarResult{
			Query:      opts.query,
			QueryTerms: queryTermsText,
			Keyword:    keyword,
			Score:      score,
			Cooccur:    acc.cooccur,
			QueryDF:    queryDF,
			KeywordDF:  keywordDF,
		})
	}

	sort.Slice(results, func(i, j int) bool {
		if results[i].Score != results[j].Score {
			return results[i].Score > results[j].Score
		}
		if results[i].Cooccur != results[j].Cooccur {
			return results[i].Cooccur > results[j].Cooccur
		}
		if results[i].KeywordDF != results[j].KeywordDF {
			return results[i].KeywordDF < results[j].KeywordDF
		}
		return results[i].Keyword < results[j].Keyword
	})
	if len(results) > opts.topN {
		results = results[:opts.topN]
	}
	return results
}

func adaptiveMinCooccurThreshold(
	opts similarOptions,
	queryDF int,
	accumulators map[string]*similarAccumulator,
	actualDF map[string]int,
) int {
	threshold := opts.minCooccur
	if threshold < 1 {
		threshold = 1
	}
	if !opts.autoMinCooccur || queryDF < 1 {
		return threshold
	}

	queryDFThreshold := int(math.Ceil(float64(queryDF) * 0.02))
	if queryDFThreshold > threshold {
		threshold = queryDFThreshold
	}

	cooccurs := make([]int, 0, len(accumulators))
	for keyword, acc := range accumulators {
		if actualDF[keyword] < opts.minKeywordDF {
			continue
		}
		cooccurs = append(cooccurs, acc.cooccur)
	}
	if len(cooccurs) == 0 {
		return threshold
	}
	sort.Sort(sort.Reverse(sort.IntSlice(cooccurs)))
	rank := opts.topN - 1
	if rank < 0 {
		rank = 0
	}
	if rank >= len(cooccurs) {
		rank = len(cooccurs) - 1
	}
	if cooccurs[rank] > threshold {
		threshold = cooccurs[rank]
	}
	maxCooccur := cooccurs[0]
	if threshold > maxCooccur && maxCooccur >= opts.minCooccur {
		threshold = maxCooccur
	}
	return threshold
}

func resolveQueryTerms(query string, expand string, actualDF map[string]int) []string {
	terms := make(map[string]struct{})
	if actualDF[query] > 0 {
		terms[query] = struct{}{}
	}
	if expand == "contains" {
		for keyword := range actualDF {
			if strings.Contains(keyword, query) {
				terms[keyword] = struct{}{}
			}
		}
	}
	result := make([]string, 0, len(terms))
	for term := range terms {
		result = append(result, term)
	}
	sort.Strings(result)
	return result
}

func bestQueryWeight(workRows map[string]*keywordRow, queryTerms []string) (float64, bool) {
	best := 0.0
	found := false
	for _, term := range queryTerms {
		row, ok := workRows[term]
		if !ok {
			continue
		}
		weight := keywordWeight(*row)
		if !found || weight > best {
			best = weight
			found = true
		}
	}
	return best, found
}

func keywordWeight(row keywordRow) float64 {
	score := row.Score
	if score <= 0 {
		score = 1
	}
	rank := row.Rank
	if rank < 1 {
		rank = 1
	}
	return score / float64(rank)
}

func writeSimilarCSV(results []similarResult, outputPath string, showQueryTerms bool) error {
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return err
	}
	file, err := os.Create(outputPath)
	if err != nil {
		return err
	}
	defer file.Close()
	return writeSimilarRows(results, file, showQueryTerms)
}

func writeSimilarRows(results []similarResult, output io.Writer, showQueryTerms bool) error {
	buffered := bufio.NewWriterSize(output, 1<<20)
	writer := csv.NewWriter(buffered)
	header := []string{"query", "keyword", "score", "cooccur", "query_df", "keyword_df"}
	if showQueryTerms {
		header = []string{"query", "query_terms", "keyword", "score", "cooccur", "query_df", "keyword_df"}
	}
	if err := writer.Write(header); err != nil {
		return err
	}
	for _, result := range results {
		record := []string{
			result.Query,
			result.Keyword,
			strconv.FormatFloat(result.Score, 'f', 6, 64),
			strconv.Itoa(result.Cooccur),
			strconv.Itoa(result.QueryDF),
			strconv.Itoa(result.KeywordDF),
		}
		if showQueryTerms {
			record = []string{
				result.Query,
				result.QueryTerms,
				result.Keyword,
				strconv.FormatFloat(result.Score, 'f', 6, 64),
				strconv.Itoa(result.Cooccur),
				strconv.Itoa(result.QueryDF),
				strconv.Itoa(result.KeywordDF),
			}
		}
		if err := writer.Write(record); err != nil {
			return err
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return err
	}
	return buffered.Flush()
}

func getCSVField(record []string, index map[string]int, name string) string {
	i, ok := index[name]
	if !ok || i < 0 || i >= len(record) {
		return ""
	}
	return record[i]
}

func parseCSVInt(record []string, index map[string]int, name string) int {
	value, err := strconv.Atoi(getCSVField(record, index, name))
	if err != nil {
		return 0
	}
	return value
}

func parseCSVFloat(record []string, index map[string]int, name string) float64 {
	value, err := strconv.ParseFloat(getCSVField(record, index, name), 64)
	if err != nil {
		return 0
	}
	return value
}
