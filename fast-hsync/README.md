# fast-hsync

Hitomi/ExHentai 메타데이터를 로컬 SQLite DB(`data.db`)에 동기화하는 Go 도구입니다.

## 준비

- Go 1.25 이상
- SQLite DB
  - 기본 파일명은 `data.db`입니다.
  - 기존 레코드가 있으면 DB의 최대 `Id` 주변을 동기화합니다.
  - 빈 DB에서 처음 시작할 때는 `--latest-id`로 기준 ID를 지정하거나 `--start-id`/`--end-id`로 전체 범위를 지정해야 합니다.

## 설치 및 빌드

```powershell
cd .\fast-hsync
go mod download
go build -o fast-hsync.exe .
```

## 기본 실행

```powershell
.\fast-hsync.exe
```

기본 실행은 현재 폴더의 `data.db`를 사용합니다.

다른 DB 파일을 사용하려면 첫 번째 위치 인자로 넘깁니다.

```powershell
.\fast-hsync.exe C:\path\to\data.db
```

빈 DB에서 처음 시작하는 경우:

```powershell
.\fast-hsync.exe data.db --latest-id=3000000
```

`--latest-id`는 처음 스캔할 기준 Hitomi ID입니다. 이 값 기준으로 앞뒤 약 1만 개씩, 총 약 2만 개 범위를 확인합니다. 한 번 데이터가 들어간 뒤에는 DB의 최대 `Id`를 자동으로 사용하므로 보통 다시 지정하지 않아도 됩니다.

0부터 4,000,000까지 전체 초기 스캔을 하고 싶으면 명시 범위를 사용합니다.

```powershell
.\fast-hsync.exe data.db --start-id=0 --end-id=4000000
```

`--end-id`는 포함되지 않는 끝값입니다. 위 명령은 `0`부터 `3,999,999`까지 확인합니다. 요청 수가 400만 개라 시간이 오래 걸리고 대상 서버에도 부하가 큽니다.

## 옵션

```powershell
.\fast-hsync.exe [DB_PATH] [OPTIONS]
```

| 옵션 | 설명 |
| --- | --- |
| `-f`, `--force` | 이미 DB에 있는 Hitomi ID도 다시 다운로드합니다. 기본값은 기존 ID를 건너뜁니다. |
| `-q`, `--quiet` | 요청별 진행률 출력은 숨기고 단계별 요약과 오류만 출력합니다. |
| `--with-exh` | ExHentai 목록도 함께 동기화하고 Hitomi 레코드와 병합합니다. |
| `--latest-id=N` | DB가 비어 있을 때 첫 동기화 기준 ID를 지정합니다. `--latest-id N` 형식도 가능합니다. |
| `--start-id=N` | 다운로드할 Hitomi gallery block 시작 ID를 지정합니다. |
| `--end-id=N` | 다운로드할 Hitomi gallery block 끝 ID를 지정합니다. 이 값은 포함되지 않습니다. |

예시:

```powershell
.\fast-hsync.exe data.db --force
.\fast-hsync.exe data.db --quiet
.\fast-hsync.exe data.db --with-exh
.\fast-hsync.exe data.db --force --with-exh
.\fast-hsync.exe data.db --latest-id=3000000
.\fast-hsync.exe data.db --start-id=0 --end-id=4000000
```

## ExHentai 동기화

`--with-exh`를 쓰면 ExHentai 일반 목록과 `Browse Expunged Galleries` 목록을 각각 증분 수집해서 다음 정보를 보강합니다.

- `EHash`
- `Uploader`
- `Published`
- `Files`
- `Class`
- ExHentai에만 있는 항목(`ExistOnHitomi = 0`)
- expunged 항목에는 기존 `Tags` 컬럼에 `expunged` 표시를 추가합니다. 별도 DB 스키마 마이그레이션은 필요하지 않습니다.
- expunged 초기 백필은 `Id >= 4,000,000`까지만 수집하며, 10페이지(최대 250개)마다 DB/FTS에 체크포인트를 저장합니다. 중간 재시작 시 이미 저장된 최신 페이지를 만나 빠르게 이어집니다.

ExHentai 쿠키는 `COOKIE` 환경변수에서 읽습니다.

```powershell
$env:COOKIE = "ipb_member_id=...; ipb_pass_hash=...; igneous=..."
.\fast-hsync.exe data.db --with-exh
```

## 실행 중 동작

1. DB에서 현재 최대 `Id`를 읽습니다.
2. 기본값은 `latest_id - 10000`부터 약 2만 개 범위의 Hitomi gallery block을 다운로드합니다. `--start-id`/`--end-id`를 지정하면 그 범위를 그대로 사용합니다.
3. ExHentai 동기화가 켜져 있으면 일반 목록과 expunged 전용 목록을 각각 읽고, expunged 항목은 `|expunged|` 태그로 표시합니다.
4. 새 항목 또는 변경된 항목만 DB에 upsert합니다.
5. FTS 테이블이 없으면 전체 생성하고, 있으면 변경된 row만 갱신합니다. Hitomi 항목과 expunged ExHentai 항목을 검색 인덱스에 포함합니다.
6. 변경된 레코드가 있으면 `chunk/data-YYYY-MM-DD_HHMMSS.json` 파일로 저장합니다.

## 생성 파일

- `data.db-wal`, `data.db-shm`: SQLite WAL 모드 보조 파일
- `chunk/data-*.json`: 이번 실행에서 새로 추가되거나 변경된 레코드 목록
- `fast-hsync.exe`: 빌드 결과물

이 파일들은 `.gitignore`에 포함되어 있습니다.

## 테스트

```powershell
go test ./...
```


## 기존 작가 누락분 복구 (WalnutPi에서 실행)

일반 동기화는 **이미 저장된 ID를 기본적으로 건너뜁니다**. 따라서 기존 작가 N/A 데이터는 별도 Python 스크립트 fast-hsync/backfill_artists.py로 복구합니다. GitHub Actions가 아니라 **원본 DB가 있는 Pi에서 실행**하며 Python 3 표준 라이브러리만 필요합니다.

- 기본값은 읽기 전용 dry-run이며 최대 20건만 검사합니다.
- 한국어 작품의 누락된 Artists 필드만 수정합니다.
- 실제 수정에는 --apply --backup-confirmed 옵션이 모두 필요합니다. 반드시 백업 파일을 검증한 다음 사용하세요.
- FtsTags가 존재하면 변경된 레코드의 검색 인덱스도 갱신합니다.
- 결과는 JSONL 파일에 기록되며 --resume 옵션으로 이미 처리한 ID를 건너뛸 수 있습니다.
- --fallback TARGET:SOURCE는 직접 검증된 동일 작품의 다른 등록본을 수동 지정할 때만 사용합니다. 대상 JS가 404이고 그룹명이 일치해야 대체합니다. 그룹 일치 자체는 동일 작품의 증거가 아니므로 먼저 제목과 내용을 확인해야 합니다.

읽기 전용 시험:

    DB=/var/lib/docker/volumes/violet_violet-content-db/_data/data.db
    python3 fast-hsync/backfill_artists.py "$DB" \
      --ids 2250876 2614220 2614221 2614222 2612491 \
      --fallback 2250876:2614220 --limit 5

**중요: 원본 SQLite의 온라인 백업을 별도 저장장치에 만들고 PRAGMA quick_check로 백업 무결성을 확인한 후에만 적용하세요.** DB 크기와 여유 공간을 확인하고 자동 갱신 시간대를 피하세요.

백업 검증 이후 실제 반영:

    sudo python3 fast-hsync/backfill_artists.py "$DB" \
      --ids 2250876 2614220 2614221 2614222 2612491 \
      --fallback 2250876:2614220 --limit 5 \
      --apply --backup-confirmed --report backfill-artists-applied.jsonl

소규모 시험을 마친 후 한국어 누락 데이터 배치 처리:

    python3 fast-hsync/backfill_artists.py "$DB" --limit 100 --resume
    sudo python3 fast-hsync/backfill_artists.py "$DB" \
      --limit 100 --apply --backup-confirmed \
      --resume --report backfill-artists-applied.jsonl

이 도구는 **원본 DB와 FtsTags만 수정**합니다. 자동으로 모바일 DB export/배포를 실행하거나 기존 동기화 chunk 파일을 생성하지 않습니다. 원본 변경이 검증된 뒤 기존 모바일 DB export 및 배포 파이프라인을 별도로 실행해야 앱에 반영됩니다.

테스트:

    cd fast-hsync
    python3 -m unittest -v test_backfill_artists.py
    go test ./...


## 기존 그룹 정보 누락 복구 (WalnutPi)

작가와 별개로 Groups가 비어 있는 **한국어 작품**을 복구하려면
fast-hsync/backfill_groups.py를 사용하세요. Python 3 표준 라이브러리로 동작하지만
같은 폴더의 backfill_artists.py에서 gallery JS 조회 도구를 가져옵니다.

- 기본 실행은 **읽기 전용 dry-run**, 최대 20개
- 기본 workers=2 (1~4), JS 내부의 ID가 요청 ID와 달라지면 `id_mismatch`로 제외
- 원본 JS에 Groups가 비어 있으면 `no_groups`로 남기고 DB를 수정하지 않음
- 이미 Groups가 있는 행과 Artists 및 기타 컬럼은 수정하지 않음
- `--apply --backup-confirmed`가 동시에 있어야 그룹과 FtsTags를 수정
- 기존 작가 백필 결과 파일과 **다른 보고서**에 기록할 것
- 그룹이 없는 레코드는 동일 작품인지 검증할 수 없으므로, 이 도구는 타 ID의
  그룹을 자동으로 추론하거나 대체하지 않습니다.

샘플 14개에 대한 읽기 전용 검증:

~~~bash
DB=/var/lib/docker/volumes/violet_violet-content-db/_data/data.db
sudo python3 ~/violet-artist-fix/fast-hsync/backfill_groups.py "$DB" \
  --ids 3269198 3415040 1165878 3196000 3425723 2999334 \
        3200939 3312755 3446385 3504519 2504867 3302295 3111717 2813510 \
  --limit 14 --report /home/pi/violet-group-dryrun.jsonl
~~~

DB 백업 무결성을 검증한 뒤 실제 반영 (예시):

~~~bash
sudo python3 ~/violet-artist-fix/fast-hsync/backfill_groups.py "$DB" \
  --ids 3269198 3415040 1165878 3196000 3425723 2999334 \
        3200939 3312755 3446385 3504519 2504867 3302295 3111717 2813510 \
  --limit 14 --apply --backup-confirmed \
  --report /home/pi/violet-group-applied.jsonl
~~~

일반 배치: `--limit 100 --resume --apply --backup-confirmed`
(작가 백필과 같은 DB를 동시에 쓰지 않도록 순차 실행).

이 스크립트는 **모바일용 DB를 자동으로 내보내지 않습니다**.
백필 후 기존 export/배포 단계를 별도로 실행해야 아이폰 앱에 반영됩니다.

테스트:

~~~bash
cd fast-hsync
python3 -m unittest -v test_backfill_artists.py test_backfill_groups.py
~~~


### 1차: Hitomi 등록 작품만 작가 복구

ExHentai 전용이거나 Hitomi에 존재하지 않는 작품을 Hitomi gallery JS에
불필요하게 요청하지 않으려면 `--hitomi-only` 옵션을 사용하세요.
이 옵션은 조회 후보 및 DB 쓰기 시 모두 `ExistOnHitomi=1`을 검사합니다.
기본값은 이전과 동일하게 모든 한국어 작가 누락 레코드를 대상으로 합니다.
**이 옵션은 ExHentai에 요청을 보내지 않습니다.**

이미 사용한 JSONL 적용 보고서를 그대로 지정하면 `--resume`으로
앞서 검사했던 ID를 건너뛸 수 있습니다.

~~~bash
DB=/var/lib/docker/volumes/violet_violet-content-db/_data/data.db

# 먼저 20개 확인: DB 쓰기 없음
sudo python3 fast-hsync/backfill_artists.py "$DB" \
  --hitomi-only --limit 20 --workers 2 \
  --report /home/pi/violet-artist-hitomi-dryrun.jsonl

# 검증된 백업 확인 후 1회 실제 반영
sudo python3 fast-hsync/backfill_artists.py "$DB" \
  --hitomi-only --limit 500 --workers 2 --resume \
  --apply --backup-confirmed \
  --report /home/pi/violet-artist-batch.jsonl
~~~

대량 배치는 위 명령을 반복하거나 tmux 등에서 순차적으로 실행하세요.
출력의 `apply: 0 rows`는 남은 **미처리 후보가 없다는 뜻**이지,
DB에서 모든 작가 누락이 사라졌다는 뜻이 아닙니다. 복구 실패/정보 없음,
`ExistOnHitomi=0`은 이후 별도 확인 대상입니다.


## ID가 다른 JS 응답(artist id_mismatch) 읽기 전용 조사

Hitomi의 오래된 gallery ID를 조회했을 때 HTTP URL은 그대로지만
JS 안의 `galleryinfo.id`가 새 등록본을 가리키는 사례가 있습니다.
같은 시리즈의 다른 분량일 수 있으므로 단순히 작가를 자동 복사하면 안 됩니다.

`audit_artist_mismatches.py`는 이전 작가 백필 JSONL의
`id_mismatch`를 읽어 원본과 새 ID의 DB 제목, 언어,
페이지 수, 그룹, JS 작가를 비교하여 분류합니다.

- **DB를 절대 수정하지 않습니다.** 별도 audit JSONL만 기록합니다.
- 대상은 기존 보고서에서 `mode=apply, status=id_mismatch`인 ID입니다.
- 요청은 순차 실행하고 기본 0.6초 대기하며, `--delay` 최소 0.5초를 강제합니다.
- `review_candidate`는 동일 작품 확정이 아닙니다. DB 제목, JS 제목,
  페이지 수(대상/소스/JS) 및 작가/그룹 충돌 여부를 통과한
  **사람이 추가 검증할 후보**입니다. 이미지 내용 동일성은 검사하지 않습니다.
- `page_count_diff` 사례(예: Ch.1-5 → Ch.1-22)는 제외합니다.
- `--resume`으로 이전 조사 기록을 재사용합니다.

~~~bash
DB=/var/lib/docker/volumes/violet_violet-content-db/_data/data.db
python3 fast-hsync/audit_artist_mismatches.py "$DB" \
  --source-report /home/pi/violet-artist-batch.jsonl \
  --report /home/pi/violet-artist-mismatch-audit.jsonl \
  --limit 30 --delay 0.6 --resume
~~~

최종적으로 자동 복구를 구현하기 전에는 이미지/원본 게시물 비교 등
추가적인 동일 작품 검증을 실시해야 합니다.


### JS와 DB 제목이 다른 경우

기존 `review_candidate`는 원본 DB, 소스 DB, JS 제목이 모두 같은 경우에만 유지합니다.
페이지 수가 같아도 JS 제목이 달라지면 자동으로 동일 작품으로 취급하지 않습니다.

- `possible_sequel`: 예를 들어 DB 제목 `futanari otoko`,
  JS 제목 `futanari otoko 2`처럼 숫자 후속편 가능성이 있어 자동 적용 금지
- `translation_title_review`: 예를 들어 DB 제목
  `06_나오미의 이어지는바다`와 JS의
  `Naomi ni Tsuzuku Umi | 나오미의 이어지는 바다`처럼
  정규화된 한글 문자열이 같고 제목이 번역/병기된 경우
  (여전히 사람의 작품 동일성 검토가 필요)
- `db_title_diff`: 원본 DB와 소스 DB 제목부터 불일치
- `js_title_missing`: JS에서 제목을 찾을 수 없어 검증 불가

구버전 보고서의 `title_diff` 결과는 `--resume` 사용 시 재검토되지 않으므로
새 결과 파일로 재검사하세요. 예: `/home/pi/violet-artist-mismatch-audit-v2.jsonl`.


## 미스매치 후보 2차 메타데이터 검토 (읽기 전용)

`rank_artist_mismatch_candidates.py`는 완료된 `audit_artist_mismatches.py`
JSONL의 각 ID별 **마지막 결과** 중 `review_candidate`와
`translation_title_review`를 뽑아서 DB의 그룹, 태그(Jaccard), 썸네일,
EHash를 비교합니다. 동일 썸네일이나 동일 태그라도 **이미지 내용이
동일하다는 뜻이 아닙니다**. EHash는 ExHentai 갤러리 식별자이며 이미지
파일 해시가 아닙니다. 이미지 동일성은 **검사하지 않고**, 작가 정보를
DB에 **일절 쓰지 않습니다**. 모든 항목에는 `image_verified: false`가
표기됩니다.

~~~bash
DB=/var/lib/docker/volumes/violet_violet-content-db/_data/data.db
sudo python3 ~/violet-hitomi-phase1/fast-hsync/rank_artist_mismatch_candidates.py "$DB" \
  --audit-report /home/pi/violet-artist-mismatch-audit-v2.jsonl \
  --report /home/pi/violet-artist-candidates-ranked.jsonl --top 25
~~~

`first_review`와 `next_review`부터 사람이 이미지/원문을 직접 확인하세요.
`metadata_conflict`는 우선 제외하며, **이 스크립트의 결과만으로
다른 ID의 작가를 복사하면 안 됩니다**.

## 그룹 백필: Hitomi 등록 작품만 우선 처리

작가 백필처럼 `backfill_groups.py --hitomi-only`를 사용하면
`ExistOnHitomi=1`인 작품만 후보로 선택하고, DB 적용 직전에도 같은
조건을 재확인합니다. 기존 백필 동작을 유지하려면 옵션을 생략하세요.

~~~bash
DB=/var/lib/docker/volumes/violet_violet-content-db/_data/data.db
# 먼저 안전하게 30개 확인 (DB 변경 없음)
sudo python3 ~/violet-hitomi-phase1/fast-hsync/backfill_groups.py "$DB" \
  --hitomi-only --limit 30 --workers 2 \
  --report /home/pi/violet-group-hitomi-dryrun.jsonl

# 온라인 백업과 PRAGMA quick_check 검증을 다시 완료한 경우에만 실제 반영
sudo python3 ~/violet-hitomi-phase1/fast-hsync/backfill_groups.py "$DB" \
  --hitomi-only --limit 200 --workers 2 --resume \
  --apply --backup-confirmed \
  --report /home/pi/violet-group-hitomi-applied.jsonl
~~~

중요: `--resume`은 해당 모드와 보고서의 이전 검사 ID를 건너뜁니다.
원본 DB의 동시 쓰기를 피하고, 적용 후 `FtsTags`를 확인하세요.
