# SpatialStat maps

Интерактивные карты SpatialStat для GitHub Pages. Каждая карта лежит в своей папке и встраивается в статью на spatialstat.com через iframe.

Первая карта — **fire-globe**: вращающийся глобус с пожарами NASA за последние 3 месяца. Из данных убраны населённые пункты, морские платформы и газовые факелы.

```
fire-globe/            карта: index.html, globe.js, globe.css
fire-globe/data/       данные для карты (их делает скрипт, вручную не правятся)
shared/                общее для всех карт: стили, логотип, контуры суши и границ, библиотека d3-geo
pipeline/fires.py      скрипт: скачивает и чистит данные о пожарах
.github/workflows/     автоматика GitHub: обновление данных и публикация сайта
DATA-LICENSE.md        лицензии и подписи источников
```

## Как опубликовать (один раз)

1. **Создайте репозиторий** на GitHub: New repository → имя `spatialstat-maps` → **Public** (GitHub Pages бесплатно работает с публичными репозиториями) → Create.
2. **Загрузите файлы.** Проще всего так: на странице репозитория нажмите *uploading an existing file* и перетащите всё содержимое этой папки, включая скрытую папку `.github`. Если перетаскивание пропустит `.github`, загрузите её отдельно или через `git`:
   ```bash
   cd spatialstat-maps
   git init && git add . && git commit -m "Fire globe"
   git branch -M main
   git remote add origin https://github.com/ВАШ-НИК/spatialstat-maps.git
   git push -u origin main
   ```
3. **Включите Pages:** Settings → Pages → Build and deployment → Source: **GitHub Actions**.
4. **Получите ключ FIRMS (бесплатно):** https://firms.modaps.eosdis.nasa.gov/api/map_key/ — введите почту, ключ придёт письмом.
5. **Добавьте ключ в репозиторий:** Settings → Secrets and variables → Actions → New repository secret. Name: `FIRMS_MAP_KEY`, Secret: ваш ключ.
6. **Запустите обновление данных:** вкладка Actions → *Update fire data* → Run workflow (по умолчанию 90 дней). Работает 10–30 минут: скачивает данные FIRMS за 90 дней (18 запросов по 5 дней), маску городов GHSL (32 МБ), чистит и публикует.
7. **Карта готова:** `https://ВАШ-НИК.github.io/spatialstat-maps/fire-globe/`

## Свой адрес maps.spatialstat.com (рекомендую)

Так адрес карт не будет зависеть от имени аккаунта GitHub.

1. Cloudflare → spatialstat.com → DNS → Add record: тип `CNAME`, имя `maps`, значение `ВАШ-НИК.github.io`, **Proxy status: DNS only** (серое облако).
2. GitHub → Settings → Pages → Custom domain: `maps.spatialstat.com` → Save. Когда проверка пройдёт, включите *Enforce HTTPS*.
3. Карта: `https://maps.spatialstat.com/fire-globe/`

Если свой адрес пока не нужен, в сайте Astro в `src/site.config.ts` поменяйте `mapsUrl` на `https://ВАШ-НИК.github.io/spatialstat-maps`.

## Как встроить в статью на Astro

В начале `.md`-файла карты (в сайте spatialstat):

```yaml
embed:
  src: fire-globe/
  title: Interactive globe of vegetation fires detected by NASA satellites
  credits:
    - name: NASA FIRMS, VIIRS NOAA-20
      url: https://firms.modaps.eosdis.nasa.gov/
    - name: GHSL Degree of Urbanisation, European Commission
      url: https://human-settlement.emergency.copernicus.eu/
      licence: CC BY 4.0
```

Сайт сам добавит iframe, ссылку «Open full screen» и строку с лицензиями под картой.

Чтобы встроить карту куда-то ещё (Substack, Medium, сайт партнёра), нажмите **Embed** в нижней строке карты: там готовый код iframe с подписью.

## Настройки карты через адрес

| Параметр | Что делает |
| --- | --- |
| `?chrome=min` | без заголовка (для встраивания под заголовком статьи) |
| `?chrome=none` | только глобус, без кнопок (для видео) |
| `?month=2026-09` | открыть на одном месяце |
| `?lon=78&lat=25&zoom=2` | начальный вид, например на Индию |
| `?speed=0` | без вращения |
| `?title=...` | свой заголовок |

## Как данные очищаются

Скрипт `pipeline/fires.py`:

1. Скачивает очаги VIIRS со спутника NOAA-20 (375 м) через FIRMS API: оперативные данные (NRT), а для старых дат — архивные (SP).
2. Оставляет отметки средней и высокой достоверности.
3. Убирает:
   - **населённые пункты:** классы 21–30 карты степени урбанизации GHS-SMOD 2025 (пригороды, малые и большие города). Деревни остаются: именно вокруг них горит большинство полей. Чтобы убрать и деревни, запустите скрипт с `--drop-villages`;
   - **море:** дальше 5 км от суши (нефтегазовые платформы);
   - **постоянные источники тепла:** одна и та же точка (~400 м) горит в 20% дней и чаще — газовые факелы, заводы, вулканы.
4. Считает отметки в ячейках сетки 0,1° (около 10 км) по месяцам и пишет `fire-globe/data/fires.json`, `stats.json` (цифры для статьи) и `fires-by-country.csv`.

### Запуск на своём компьютере (необязательно)

Нужен Python 3.10+.

```bash
pip install -r pipeline/requirements.txt
set FIRMS_MAP_KEY=ваш_ключ          # Windows (в PowerShell: $env:FIRMS_MAP_KEY="ваш_ключ")
python pipeline/fires.py --days 90
```

Можно без ключа, с файлами, скачанными вручную в [Archive Download](https://firms.modaps.eosdis.nasa.gov/download/) (World, VIIRS NOAA-20, CSV):

```bash
python pipeline/fires.py --csv-dir папка_с_csv --start 2026-07-21 --end 2026-10-18
```

Проверить карту локально: `python -m http.server 8000` в папке репозитория, затем откройте http://localhost:8000/fire-globe/

## Лицензии

Код — MIT. Оформление карт — © SpatialStat, CC BY-NC-ND 4.0. Обработанные данные — CC BY 4.0. Подписи источников (NASA FIRMS, GHSL, Natural Earth) — в `DATA-LICENSE.md`; они же всегда видны в нижней строке каждой карты.
