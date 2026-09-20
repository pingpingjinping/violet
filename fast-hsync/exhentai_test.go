package main

import (
	"strings"
	"testing"
)

func TestGetEHID(t *testing.T) {
	art := &EHArticle{URL: "https://exhentai.org/g/3217489/abcdef1234/"}
	if id := getEHID(art); id != 3217489 {
		t.Errorf("getEHID = %d, want 3217489", id)
	}
}

func TestGetEHHash(t *testing.T) {
	art := &EHArticle{URL: "https://exhentai.org/g/3217489/abcdef1234/"}
	if h := getEHHash(art); h != "abcdef1234" {
		t.Errorf("getEHHash = %q, want abcdef1234", h)
	}
}

func TestNormalizeEHTag(t *testing.T) {
	tests := []struct {
		tag, cat, want string
	}{
		{"loli", "female", "female:loli"},
		{"lolicon", "female", "female:loli"},
		{"yaoi", "male", "male:yaoi"},
		{"shotacon", "male", "male:shota"},
		{"glasses", "misc", "glasses"},
		{"full color", "other", "full color"},
	}
	for _, tc := range tests {
		if got := normalizeEHTag(tc.tag, tc.cat); got != tc.want {
			t.Errorf("normalizeEHTag(%q, %q) = %q, want %q", tc.tag, tc.cat, got, tc.want)
		}
	}
}

func TestExHentaiBrowseURLExpunged(t *testing.T) {
	normal := exHentaiBrowseURL(123, false)
	if strings.Contains(normal, "f_sh=on") {
		t.Fatalf("normal URL unexpectedly enables expunged browsing: %s", normal)
	}
	expunged := exHentaiBrowseURL(456, true)
	if !strings.Contains(expunged, "f_sh=on") {
		t.Fatalf("expunged URL missing f_sh=on: %s", expunged)
	}
	if !strings.Contains(expunged, "next=456") {
		t.Fatalf("expunged URL missing cursor: %s", expunged)
	}
}

func TestSetPipeTag(t *testing.T) {
	if got := setPipeTag("|female:loli|", expungedTag, true); got != "|female:loli|expunged|" {
		t.Fatalf("add expunged = %q", got)
	}
	if got := setPipeTag("|female:loli|expunged|", expungedTag, false); got != "|female:loli|" {
		t.Fatalf("remove expunged = %q", got)
	}
	if got := setPipeTag("", expungedTag, true); got != "|expunged|" {
		t.Fatalf("empty add expunged = %q", got)
	}
}

func TestFilterExpungedMinID(t *testing.T) {
	articles := []*EHArticle{
		{URL: "https://exhentai.org/g/4000100/a/"},
		{URL: "https://exhentai.org/g/4000000/b/"},
		{URL: "https://exhentai.org/g/3999999/c/"},
	}
	filtered := filterExpungedMinID(articles, expungedMinID)
	if len(filtered) != 2 {
		t.Fatalf("filtered len = %d, want 2", len(filtered))
	}
	if getEHID(filtered[0]) != 4000100 || getEHID(filtered[1]) != 4000000 {
		t.Fatalf("unexpected filtered IDs: %d, %d", getEHID(filtered[0]), getEHID(filtered[1]))
	}
}

func TestCheckpointExpungedArticlesMergesExistingID(t *testing.T) {
	db, err := openDB(t.TempDir() + "/checkpoint.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := createTable(db); err != nil {
		t.Fatal(err)
	}

	existing := &HitomiColumnModel{
		ID:            4000010,
		Title:         "Hitomi copy",
		Artists:       "|artist1|",
		Language:      "korean",
		Tags:          "|female:loli|",
		ExistOnHitomi: 1,
	}
	if err := upsertArticles(db, []*HitomiColumnModel{existing}); err != nil {
		t.Fatal(err)
	}
	if err := rebuildFts(db); err != nil {
		t.Fatal(err)
	}

	batch := []*EHArticle{
		{
			URL:      "https://exhentai.org/g/4000010/hash1/",
			Title:    "Existing EH copy",
			Expunged: true,
		},
		{
			URL:      "https://exhentai.org/g/4000020/hash2/",
			Title:    "New expunged",
			Expunged: true,
			Descripts: map[string][]string{
				"language": {"korean"},
			},
		},
	}
	if err := checkpointExpungedArticles(db, batch); err != nil {
		t.Fatal(err)
	}

	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM HitomiColumnModel").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("row count = %d, want 2", count)
	}

	rows, err := getExistingByIDs(db, []int{4000010, 4000020})
	if err != nil {
		t.Fatal(err)
	}
	if rows[4000010].Title != "Hitomi copy" {
		t.Fatalf("existing title was replaced: %q", rows[4000010].Title)
	}
	if rows[4000010].ExistOnHitomi != 1 {
		t.Fatalf("existing Hitomi flag changed: %d", rows[4000010].ExistOnHitomi)
	}
	if !strings.Contains(rows[4000010].Tags, "|expunged|") {
		t.Fatalf("existing row missing expunged tag: %q", rows[4000010].Tags)
	}
	if rows[4000020].ExistOnHitomi != 0 {
		t.Fatalf("new ExH-only row flag = %d, want 0", rows[4000020].ExistOnHitomi)
	}
	if !strings.Contains(rows[4000020].Tags, "|expunged|") {
		t.Fatalf("new row missing expunged tag: %q", rows[4000020].Tags)
	}
}


func TestParseExHentaiExtendedList(t *testing.T) {
	html := `<html><body>
	<table class="itg glte">
		<tr>
			<td>
				<div><a href="https://exhentai.org/g/3217489/abc123def/"><img src="https://exhentai.org/t/thumb.jpg" /></a></div>
			</td>
			<td>
				<div>
					<div>
						<div>doujinshi</div>
						<div>2024-06-15 10:30</div>
						<div>★★★</div>
						<div>someuploader</div>
						<div>30 pages</div>
					</div>
					<a href="https://exhentai.org/g/3217489/abc123def/">
						<div>
							<div>(C99) [Circle] Test Title</div>
							<div>
								<table>
									<tr><td>female:</td><td><div>lolicon</div><div>glasses</div></td></tr>
									<tr><td>male:</td><td><div>shotacon</div></td></tr>
									<tr><td>artist:</td><td><div>testartist</div></td></tr>
									<tr><td>language:</td><td><div>japanese</div><div>translated</div></td></tr>
									<tr><td>parody:</td><td><div>original</div></td></tr>
									<tr><td>group:</td><td><div>testgroup</div></td></tr>
								</table>
							</div>
						</div>
					</a>
				</div>
			</td>
		</tr>
	</table>
	</body></html>`

	articles := parseExHentaiExtendedList(html)
	if len(articles) != 1 {
		t.Fatalf("got %d articles, want 1", len(articles))
	}

	a := articles[0]
	if a.URL != "https://exhentai.org/g/3217489/abc123def/" {
		t.Errorf("URL = %q", a.URL)
	}
	if a.Title != "(C99) [Circle] Test Title" {
		t.Errorf("Title = %q", a.Title)
	}
	if a.Type != "doujinshi" {
		t.Errorf("Type = %q", a.Type)
	}
	if a.Published != "2024-06-15 10:30" {
		t.Errorf("Published = %q", a.Published)
	}
	if a.Uploader != "someuploader" {
		t.Errorf("Uploader = %q", a.Uploader)
	}
	if a.Files != "30 pages" {
		t.Errorf("Files = %q", a.Files)
	}

	// Check tags
	if fem := a.Descripts["female"]; len(fem) != 2 || fem[0] != "lolicon" || fem[1] != "glasses" {
		t.Errorf("female tags = %v", fem)
	}
	if male := a.Descripts["male"]; len(male) != 1 || male[0] != "shotacon" {
		t.Errorf("male tags = %v", male)
	}
	if art := a.Descripts["artist"]; len(art) != 1 || art[0] != "testartist" {
		t.Errorf("artist = %v", art)
	}
	if lang := a.Descripts["language"]; len(lang) != 2 {
		t.Errorf("language = %v", lang)
	}
	if parody := a.Descripts["parody"]; len(parody) != 1 || parody[0] != "original" {
		t.Errorf("parody = %v", parody)
	}
}

func TestEHArticleToColumnModel(t *testing.T) {
	art := &EHArticle{
		URL:       "https://exhentai.org/g/3217489/abc123def/",
		Title:     "(C99) [Circle] Test Title",
		Type:      "doujinshi",
		Uploader:  "someuploader",
		Published: "2024-06-15 10:30",
		Files:     "30 pages",
		Expunged:  true,
		Descripts: map[string][]string{
			"artist":    {"testartist"},
			"female":    {"lolicon", "glasses"},
			"male":      {"shotacon"},
			"language":  {"japanese", "translated"},
			"parody":    {"original"},
			"group":     {"testgroup"},
			"character": {"charA"},
		},
	}

	m := ehArticleToColumnModel(art)

	if m.ID != 3217489 {
		t.Errorf("ID = %d", m.ID)
	}
	if m.EHash != "abc123def" {
		t.Errorf("EHash = %q", m.EHash)
	}
	if m.Class != "C99" {
		t.Errorf("Class = %q", m.Class)
	}
	if m.ExistOnHitomi != 0 {
		t.Errorf("ExistOnHitomi = %d, want 0", m.ExistOnHitomi)
	}
	if m.Artists != "|testartist|" {
		t.Errorf("Artists = %q", m.Artists)
	}
	if m.Groups != "|testgroup|" {
		t.Errorf("Groups = %q", m.Groups)
	}
	if m.Characters != "|charA|" {
		t.Errorf("Characters = %q", m.Characters)
	}
	if m.Series != "|original|" {
		t.Errorf("Series = %q", m.Series)
	}
	if m.Language != "japanese" {
		t.Errorf("Language = %q", m.Language)
	}
	if m.Files != 30 {
		t.Errorf("Files = %d", m.Files)
	}
	if m.Tags != "|female:loli|female:glasses|male:shota|expunged|" {
		t.Errorf("Tags = %q", m.Tags)
	}
}

func TestMergeEHIntoModel(t *testing.T) {
	model := &HitomiColumnModel{
		ID: 12345, Title: "Hitomi Title", Artists: "|artist1|",
		Language: "korean", ExistOnHitomi: 1,
	}
	eh := &EHArticle{
		URL:       "https://exhentai.org/g/12345/hash999/",
		Title:     "(C100) EH Title",
		Uploader:  "uploader1",
		Published: "2024-07-01 12:00",
		Files:     "42 pages",
	}

	mergeEHIntoModel(model, eh)

	if model.EHash != "hash999" {
		t.Errorf("EHash = %q", model.EHash)
	}
	if model.Uploader != "uploader1" {
		t.Errorf("Uploader = %q", model.Uploader)
	}
	if model.Files != 42 {
		t.Errorf("Files = %d", model.Files)
	}
	if model.Class != "C100" {
		t.Errorf("Class = %q", model.Class)
	}
	if model.Published == nil {
		t.Error("Published is nil")
	}
	// Original fields should be preserved
	if model.Title != "Hitomi Title" {
		t.Errorf("Title changed to %q", model.Title)
	}
	if model.ExistOnHitomi != 1 {
		t.Errorf("ExistOnHitomi changed to %d", model.ExistOnHitomi)
	}

	expunged := &EHArticle{
		URL:      "https://exhentai.org/g/12345/hash999/",
		Expunged: true,
	}
	mergeEHIntoModel(model, expunged)
	if model.Tags != "|expunged|" {
		t.Fatalf("expunged marker not added: %q", model.Tags)
	}

	normal := &EHArticle{URL: "https://exhentai.org/g/12345/hash999/"}
	mergeEHIntoModel(model, normal)
	if model.Tags != "" {
		t.Fatalf("expunged marker not removed after de-expunge: %q", model.Tags)
	}
}

func TestParseExHentaiEmpty(t *testing.T) {
	articles := parseExHentaiExtendedList("<html><body></body></html>")
	if len(articles) != 0 {
		t.Errorf("got %d articles, want 0", len(articles))
	}
}
