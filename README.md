# 두 발로 쓰는 지도 — 3D 산행 아카이브

전국 3D 산악 지형 위에 산행 GPS 동선을 그리고, 각 산행을 다음카페 산행기로 연결하는 인터랙티브 웹 지도.

## 사용법

### 1. GPX 넣기
아버지의 GPX 파일을 `data/gpx/`에 복사한다. 파일명에 날짜가 있으면 자동 인식된다 (예: `2024-05-11_북한산.gpx`).

### 2. 메타데이터 연결 (선택)
`data/hikes.csv`를 만들어 산행기 링크 등을 연결한다:

```csv
file,date,mountain,title,cafe_url
2024-05-11_북한산.gpx,2024-05-11,북한산,북한산 백운대 산행,https://cafe.daum.net/woosengzlsamo/...
```

CSV에 없는 항목은 GPX에서 자동 추출된다 (날짜: trkpt time 또는 파일명, 산이름: 트랙 name 또는 파일명).

### 2-1. 카페 산행기 자동 매칭 (선택)
```sh
python3 scripts/crawl_cafe.py    # 카페 게시판 글 목록 수집 -> data/cafe_posts.json
python3 scripts/match_posts.py   # GPX와 날짜/제목 매칭 -> data/hikes.csv 생성
```
매칭 결과(`data/hikes.csv`)를 검토·수정한 뒤 빌드하면 산행기 링크가 연결된다.

### 3. 빌드
```sh
python3 scripts/build_data.py
```
`web/data/tracks/*.json`과 `web/data/index.json`이 생성된다. 의존성 없음 (Python 표준 라이브러리만 사용).

### 4. 로컬 확인
```sh
python3 -m http.server 8931 --directory web
# http://localhost:8931
```

### 5. 배포 (GitHub Pages)
`web/`만 `gh-pages` 브랜치로 올린다.
```sh
git subtree push --prefix web origin gh-pages
```
새 산행을 추가할 때는 GPX 복사 → `build_data.py` → 커밋 → 위 명령 순서로 반복한다.

`scripts/server.py`와 `scripts/upload.html`은 예전 업로드 서버용으로, 현재 배포에는 쓰이지 않는다.

## 구조
- `web/` — 정적 사이트 (MapLibre GL JS). GitHub Pages로 배포되는 부분
- `scripts/build_data.py` — GPX → 웹 데이터 파이프라인 (간소화, 거리/상승고도 계산, 고도 프로필)
- `data/gpx/` — GPX 원본 (배포에 포함되지 않음)

## 데이터 출처
- 지형(고도): Mapzen/AWS Terrain Tiles (terrarium, 무료 공개)
- 위성영상: Esri World Imagery
- 추후 고해상도 업그레이드: 국토지리정보원 DEM 5m → terrain-rgb 타일 변환
