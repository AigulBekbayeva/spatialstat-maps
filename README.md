# SpatialStat maps

Интерактивные карты SpatialStat для GitHub Pages. Каждая карта лежит в своей папке и встраивается в статью на spatialstat.com через iframe.

Карты:

- **fire-globe**: вращающийся глобус с пожарами NASA за последние 3 месяца. Из данных убраны населённые пункты, морские платформы и газовые факелы.
- **rain-globe**: где дожди становятся экстремальными. Число дней в году с осадками 50 мм и больше, 2000–2010 против 2016–2025, по реанализу ERA5.

```
fire-globe/            карта: index.html, globe.js, globe.css
fire-globe/data/       данные для карты (их делает скрипт, вручную не правятся)
shared/                общее для всех карт: стили, логотип, контуры суши и границ, библиотека d3-geo
pipeline/fires.py      скрипт: скачивает и чистит данные о пожарах
rain-globe/            карта дождей: index.html, rain.js, rain.css, data/
pipeline/extreme_rain.py  скрипт: скачивает ERA5 и считает дни с сильным дождём
pipeline/era5-years/   итоги по каждому году (делает скрипт, нужны для пересборки)
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
| `?labels=0` / `?labels=hot` | без подписей / только выноски с главными очагами |
| `?base=dark` | тёмная карта вместо спутникового снимка |
| `?title=...` | свой заголовок |

## Как данные очищаются

Скрипт `pipeline/fires.py`:

1. Скачивает очаги VIIRS со спутника NOAA-20 (375 м) через FIRMS API: оперативные данные (NRT), а для старых дат — архивные (SP).
2. Оставляет отметки средней и высокой достоверности.
3. Убирает:
   - **населённые пункты:** классы 21–30 карты степени урбанизации GHS-SMOD 2025 (пригороды, малые и большие города). Деревни остаются: именно вокруг них горит большинство полей. Чтобы убрать и деревни, запустите скрипт с `--drop-villages`;
   - **море:** дальше 5 км от суши (нефтегазовые платформы);
   - **постоянные источники тепла:** одна и та же точка (~400 м) горит в 20% дней и чаще — газовые факелы, заводы, вулканы.
4. Считает отметки в ячейках сетки 0,1° (около 10 км) по месяцам и пишет `fire-globe/data/fires.json`, `stats.json` (цифры для статьи), `fires-by-country.csv` и `hotspots.json` (подписи главных очагов на глобусе для каждого месяца).

Подложка глобуса — снимок NASA Blue Marble (`shared/base/blue-marble-*.jpg`, общественное достояние). Он показывает поверхность Земли, а не облака на эти даты.

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

## Карта дождей (rain-globe)

**Что показывает.** Для каждой ячейки сетки ERA5 (0,25°, около 28 км) скрипт считает, сколько дней в году выпало 50 мм осадков и больше, и усредняет по двум периодам: 2000–2010 и 2016–2025. На карте четыре вида: каждый период отдельно, «Change» (разница) и **2026** — текущий год отдельно: только завершённые месяцы (сейчас январь–сентябрь), в сравнении со средним за те же месяцы 2000–2010. Если в 2026 году дней больше, чем в любом году обоих периодов, подсказка пишет *most in any year shown*. Яркие изменения больше обычных колебаний от года к году (t-тест Уэлча по годовым значениям, p < 0,05), бледные могут быть случайностью. Кнопка **Compare** переключает периоды туда-обратно, при наведении видны цифры в точке.

**Откуда данные.** Это ERA5 из двух мест. Законченные годы (2000–2025) читаются из **ARCO-ERA5** — открытой копии ERA5 от Google в облаке (почасовые значения, суммируются в сутки по UTC; без ключа, несколько минут на год). Текущий 2026 год берётся из **Copernicus Climate Data Store** (суточная статистика ERA5), потому что копия Google отстаёт на несколько месяцев. Copernicus считает такие запросы медленно (около 20 минут на месяц), поэтому для истории он не годится. Open-Meteo не подошёл: он отдаёт данные по точкам, а 21 год для миллиона точек сетки — это десятки миллионов вызовов API.

### Как запустить (один раз)

1. **Зарегистрируйтесь в Copernicus CDS** (бесплатно): https://cds.climate.copernicus.eu → Login/Register.
2. **Примите лицензию набора данных:** откройте страницу «ERA5 post-processed daily statistics on single levels from 1940 to present» (https://cds.climate.copernicus.eu/datasets/derived-era5-single-levels-daily-statistics) → вкладка *Download* → внизу *Terms of use* → Accept.
3. **Скопируйте токен:** иконка профиля → *Your profile* → *API Token*.
4. **Добавьте его в репозиторий:** Settings → Secrets and variables → Actions → New repository secret. Name: `CDSAPI_KEY`, Secret: токен.
5. **Запустите:** Actions → *Update rain data* → Run workflow.

Сначала скачиваются месяцы 2026 года из Copernicus, потом история из ARCO-ERA5 (21 год, ожидается от 1 до 3 часов). Каждый готовый год сразу сохраняется в `pipeline/era5-years/` и коммитится. GitHub ограничивает запуск 6 часами: если workflow остановился, а в сводке написано *Still missing*, просто запустите его ещё раз — он продолжит с недостающих лет. Когда все годы на месте, он сам соберёт данные карты и опубликует сайт.

**Новые месяцы 2026 года.** ERA5 отстаёт от реального времени примерно на 5 дней. Чтобы добавить октябрь и следующие месяцы, запускайте workflow после 6-го числа: он скачает только новые месяцы (минут 10–20) и пересоберёт карту. Можно включить автозапуск 8-го числа каждого месяца: в `.github/workflows/rain-data.yml` уберите `#` у строк `schedule`. В 2027 году скрипт сам докачает декабрь 2026-го, а отдельный вид переключится на 2027, когда будет готов январь; менять ничего не нужно.

Карта: `https://ВАШ-НИК.github.io/spatialstat-maps/rain-globe/`

### Настройки карты дождей через адрес

| Параметр | Что делает |
| --- | --- |
| `?view=a` / `?view=b` / `?view=change` / `?view=c` | открыть на 2000–2010, 2016–2025, изменении (по умолчанию) или 2026 |
| `?land=1` | только суша, без осадков над океаном |
| `?lon=80&lat=20&zoom=2` | начальный вид |
| `?chrome=min`, `?chrome=none`, `?speed=0`, `?labels=0`, `?title=...` | как у fire-globe |

### Цифры для статьи

`rain-globe/data/stats.json`: блок `current` с цифрами по 2026 году (доля дождливой суши выше нормы и с рекордом, места с наибольшим превышением), средние по суше и океану для каждого периода, доля суши с заметным ростом и падением, значения по каждому году, страны и ячейки с наибольшим ростом и падением. `rain-globe/data/rain-by-country.csv`: всё по странам (дни ≥50 мм, самый дождливый день, годовая сумма).

**Оговорка для текста.** ERA5 — реанализ (модель + наблюдения), его ячейки по 28 км сглаживают самые сильные локальные ливни. Поэтому дней ≥50 мм в ERA5 меньше, чем на метеостанциях, особенно в горах и в грозах. Карта корректно сравнивает периоды между собой, но не показывает местные рекорды.

Запуск у себя: `pip install -r pipeline/requirements-rain.txt`, затем `CDSAPI_KEY=токен python pipeline/extreme_rain.py fetch` и `python pipeline/extreme_rain.py build`.

## Лицензии

Код — MIT. Оформление карт — © SpatialStat, CC BY-NC-ND 4.0. Обработанные данные — CC BY 4.0. Подписи источников (NASA FIRMS, GHSL, ERA5/Copernicus, Natural Earth) — в `DATA-LICENSE.md`; они же всегда видны в нижней строке каждой карты.
