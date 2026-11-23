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
