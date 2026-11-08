package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"
)

func TestKeywordRowPackedWidth(t *testing.T) {
	// Raspberry Pi/ARM64 and GitHub Actions runners are 64-bit.
	if unsafe.Sizeof(uintptr(0)) == 8 && unsafe.Sizeof(keywordRow{}) != 64 {
		t.Fatalf("keywordRow is %d bytes, want 64", unsafe.Sizeof(keywordRow{}))
	}
}

func TestCompactWorkLookupAndDedup(t *testing.T) {
	rows := []keywordRow{
		{ArticleID: "one", Keyword: "z", Score: 2, Rank: 1},
		{ArticleID: "one", Keyword: "b", Score: 3, Rank: 1},
		{ArticleID: "two", Keyword: "b", Score: 4, Rank: 1},
		{ArticleID: "one", Keyword: "b", Score: 3, Rank: 1}, // equal-weight tie: first wins
		{ArticleID: "one", Keyword: "a", Score: 1, Rank: 1},
		{ArticleID: "one", Keyword: "z", Score: 5, Rank: 1}, // stronger duplicate
	}
	index := newKeywordIndex(rows)
	work := index.works["one"]
	if len(work) != 3 {
		t.Fatalf("one has %d keywords, want 3", len(work))
	}
	for i, keyword := range []string{"a", "b", "z"} {
		if work[i].Keyword != keyword {
			t.Fatalf("position %d: got %q, want %q", i, work[i].Keyword, keyword)
		}
	}
	if got, ok := work.get("b"); !ok || got != &rows[1] {
		t.Fatalf("equal-weight duplicate chose %p, want %p", got, &rows[1])
	}
	if got, ok := work.get("z"); !ok || got != &rows[5] {
		t.Fatalf("stronger duplicate chose %p, want %p", got, &rows[5])
	}
	if _, ok := work.get("missing"); ok {
		t.Fatal("missing keyword returned an entry")
	}
	if index.actualDF["b"] != 2 || len(index.keywordWorks["b"]) != 2 {
		t.Fatalf("actual DF = %d, reverse rows = %d", index.actualDF["b"], len(index.keywordWorks["b"]))
	}
}

func TestReadKeywordCSVRejectsOutOfRangeCounter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oversize.csv")
	csv := "article_id,rank,keyword,score,tf,df,total_pages,dialogue_count,char_count\n" +
		"one,2147483648,example,1,1,1,1,1,1\n"
	if err := os.WriteFile(path, []byte(csv), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := readKeywordCSV(path)
	if err == nil || !strings.Contains(err.Error(), "32-bit index range") {
		t.Fatalf("expected overflow error, got %v", err)
	}
}
