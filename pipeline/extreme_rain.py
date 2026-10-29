"""
SpatialStat rain globe: where is rainfall becoming extreme?

Counts, for every ERA5 grid cell (0.25 degrees, about 28 km), the days a year with 50 mm of rain or more,
and compares 2000-2010 with 2016-2025.

Two steps
  fetch   Downloads ERA5 daily precipitation from the Copernicus Climate Data Store, one month per request,
          and keeps only small yearly summaries in pipeline/era5-years/YYYY.npz:
            r50, r100  days with at least 50 / 100 mm
            rx1day     wettest day of the year, 0.1 mm
            total      yearly precipitation, mm
            r50_month  days with at least 50 mm in each month (to compare part of a year)
          The big daily files are deleted after each month, so the job needs little disk space.
          The current year (2026) is downloaded too, complete months only, and shown on its own against the
          same months of 2000-2010; each run adds the months that have become available since.
          Years already in pipeline/era5-years/ are skipped, so a run that stops can simply be started again.
  build   Averages the yearly summaries over the two periods, tests where the change is larger than
          year-to-year noise, and writes rain-globe/data/ (rain.json for the globe, stats.json for the article,
          hotspots.json for the labels, rain-by-country.csv).

Run locally
  pip install -r pipeline/requirements-rain.txt
  CDSAPI_KEY=your-token python pipeline/extreme_rain.py fetch
  python pipeline/extreme_rain.py build

The CDS token is free: register at https://cds.climate.copernicus.eu, accept the licence of the dataset
"ERA5 post-processed daily statistics on single levels", and copy the token from your profile page.
"""
from __future__ import annotations

import argparse
import calendar
import datetime as dt
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
YEARS_DIR = ROOT / 'pipeline' / 'era5-years'
CACHE = ROOT / 'pipeline' / 'cache'
OUT = ROOT / 'rain-globe' / 'data'

CDS_URL = 'https://cds.climate.copernicus.eu/api'
DATASET = 'derived-era5-single-levels-daily-statistics'
NE_COUNTRIES = ('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/'
                'ne_50m_admin_0_countries.geojson')
NE_LAND = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson'

# Global mean precipitation in ERA5 is close to 2.9 mm a day. Used to check the units of the download.
GLOBAL_MEAN_MM_DAY = 2.9
# Possible meanings of the downloaded number, and the factor that turns it into mm a day.
UNIT_FACTORS = {
    'm per day (daily sum)': 1000.0,
    'm per hour (daily mean of hourly totals)': 24_000.0,
    'm per second': 86_400_000.0,
    'mm (kg m-2) per second': 86_400.0,
    'mm per day': 1.0,
    'mm per hour': 24.0,
}

_print_lock = threading.Lock()
# The netCDF/HDF5 libraries are not thread-safe: downloads run in parallel, but files are read one at a time.
NETCDF_LOCK = threading.Lock()


def log(*a):
    with _print_lock:
        print(*a, flush=True)


def download(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f'  downloading {url.split("/")[-1]} ...')
    req = urllib.request.Request(url, headers={'User-Agent': 'SpatialStat pipeline (info@spatialstat.com)'})
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, 'wb') as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    return dest


def parse_period(s: str) -> list[int]:
    a, b = s.split('-')
    return list(range(int(a), int(b) + 1))


# ---------------------------------------------------------------- 1. fetch

def cds_client(key: str | None):
    import cdsapi
    if key:
        return cdsapi.Client(url=os.environ.get('CDSAPI_URL', CDS_URL), key=key, quiet=True, progress=False)
    return cdsapi.Client(quiet=True, progress=False)  # reads ~/.cdsapirc


def request_month(client, year: int, month: int, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = {
        'product_type': 'reanalysis',
        'variable': ['total_precipitation'],
        'year': str(year),
        'month': [f'{month:02d}'],
        'day': [f'{d:02d}' for d in range(1, 32)],
        # The mean of the 24 hourly totals; the units are checked and converted in read_month().
        'daily_statistic': 'daily_mean',
        'time_zone': 'utc+00:00',
        'frequency': '1_hourly',
        'data_format': 'netcdf',
        'download_format': 'unarchived',
    }
    tmp = dest.with_suffix('.part')
    attempt, waited = 0, 0
    while attempt < 5:
        try:
            t0 = time.time()
            client.retrieve(DATASET, req, str(tmp))
            tmp.rename(dest)
            log(f'  {year}-{month:02d}: downloaded {dest.stat().st_size / 1e6:.0f} MB in {(time.time() - t0) / 60:.1f} min')
            return dest
        except Exception as e:
            msg = str(e)
            if 'queued requests' in msg.lower() and waited < 90 * 60:
                # CDS queue for this dataset is full (e.g. jobs left over from an earlier run): wait, don't count it
                log(f'  {year}-{month:02d}: CDS queue full, waiting 2 min')
                time.sleep(120)
                waited += 120
                continue
            attempt += 1  # network error, server hiccup: wait longer each time
            log(f'  {year}-{month:02d}: attempt {attempt} failed: {msg[:300]}')
            time.sleep(60 * attempt)
    raise RuntimeError(f'Could not download {year}-{month:02d}')


def open_dataset(path: Path):
    import xarray as xr
    if zipfile.is_zipfile(path):  # some CDS versions zip the netCDF
        with zipfile.ZipFile(path) as z:
            name = next(n for n in z.namelist() if n.endswith('.nc'))
            z.extract(name, path.parent)
        inner = path.parent / name
        ds = xr.open_dataset(inner).load()
        inner.unlink()
        return ds
    return xr.open_dataset(path).load()


def unit_factor(field: np.ndarray, lat: np.ndarray) -> tuple[float, str]:
    """Pick the unit that makes the global mean closest to ~2.9 mm a day."""
    w = np.cos(np.deg2rad(lat))[None, :, None] * np.ones_like(field[:1])
    raw = float(np.nansum(np.nanmean(field, axis=0, keepdims=True) * w) / np.nansum(w))
    if raw <= 0:
        raise SystemExit(f'Downloaded precipitation has a global mean of {raw}; cannot be right.')
    best = min(UNIT_FACTORS.items(), key=lambda kv: abs(np.log(raw * kv[1] / GLOBAL_MEAN_MM_DAY)))
    mm = raw * best[1]
    if not 1.2 < mm < 6.0:
        raise SystemExit(f'Cannot work out the precipitation units (raw global mean {raw:g}).')
    return best[1], best[0]


def read_month(path: Path) -> dict:
    """Daily precipitation in mm for one month, as (days, lat, lon), plus the grid."""
    ds = open_dataset(path)
    var = next((v for v in ['tp', 'total_precipitation'] if v in ds.data_vars), list(ds.data_vars)[0])
    da = ds[var]
    tdim = next(d for d in da.dims if 'time' in d)
    da = da.transpose(tdim, 'latitude', 'longitude')
    lat = da['latitude'].to_numpy().astype(np.float64)
    lon = da['longitude'].to_numpy().astype(np.float64)
    field = da.to_numpy().astype(np.float32)
    ds.close()
    factor, unit = unit_factor(field, lat)
    mm = field * np.float32(factor)
    mm[mm < 0] = 0  # tiny negative values from the model's packing
    return {'mm': mm, 'lat': lat, 'lon': lon, 'unit': unit, 'days': int(mm.shape[0])}


def summarise_month(m: dict) -> dict:
    mm = m['mm']
    return {
        'r50': (mm >= 50).sum(axis=0).astype(np.uint16),
        'r100': (mm >= 100).sum(axis=0).astype(np.uint16),
        'rx1day': np.nanmax(mm, axis=0).astype(np.float32),
        'total': np.nansum(mm, axis=0).astype(np.float32),
        'days': m['days'], 'lat': m['lat'], 'lon': m['lon'], 'unit': m['unit'],
    }


def complete_months(year: int, today: dt.date | None = None, latency_days: int = 6) -> list[int]:
    """Months of `year` that are complete in ERA5 (it runs about 5 days behind real time)."""
    today = today or dt.datetime.now(dt.timezone.utc).date()
    last_day = today - dt.timedelta(days=latency_days)
    out = []
    for m in range(1, 13):
        end = dt.date(year, m, calendar.monthrange(year, m)[1])
        if end <= last_day:
            out.append(m)
    return out


def read_year(path: Path) -> dict:
    z = np.load(path)
    d = {k: z[k] for k in z.files}
    d['info'] = json.loads(str(z['info']))
    return d


def fetch_year(client, year: int, workers: int, keep: bool, months: list[int] | None = None) -> Path:
    """Download the given months of a year (all 12 by default) and save the yearly summary.
    For the current, unfinished year, months already saved are kept and only new ones are downloaded."""
    out = YEARS_DIR / f'{year}.npz'
    months = months or list(range(1, 13))
    old = read_year(out) if out.exists() else None
    have = old['info'].get('months', list(range(1, 13))) if old else []
    todo = [m for m in months if m not in have]
    tmpdir = CACHE / 'era5'
    parts: dict[int, dict] = {}

    def job(month):
        f = request_month(client, year, month, tmpdir / f'{year}-{month:02d}.nc')
        with NETCDF_LOCK:  # one month in memory at a time, and netCDF is not thread-safe
            s = summarise_month(read_month(f))
        if not keep:
            f.unlink(missing_ok=True)
        return month, s

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for fut in as_completed([ex.submit(job, m) for m in todo]):
            month, s = fut.result()
            parts[month] = s
    for m, p in parts.items():
        expected = calendar.monthrange(year, m)[1]
        if p['days'] != expected:
            raise SystemExit(f'{year}-{m:02d}: got {p["days"]} days, expected {expected}')
    ms = [parts[m] for m in sorted(parts)]
    ref = ms[0]
    shape = ref['r50'].shape
    if old:
        r50 = old['r50'].astype(np.uint32); r100 = old['r100'].astype(np.uint32)
        rx1 = old['rx1day'].astype(np.float32) / 10; total = old['total'].astype(np.float32)
        r50m = old['r50_month'].copy()
    else:
        r50 = np.zeros(shape, np.uint32); r100 = np.zeros(shape, np.uint32)
        rx1 = np.zeros(shape, np.float32); total = np.zeros(shape, np.float32)
        r50m = np.zeros((12,) + shape, np.uint8)
    for m, p in parts.items():
        r50 += p['r50']; r100 += p['r100']; rx1 = np.maximum(rx1, p['rx1day']); total += p['total']
        r50m[m - 1] = p['r50']
    got = sorted(set(have) | set(parts))
    days = sum(calendar.monthrange(year, m)[1] for m in got)
    YEARS_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out, r50=r50.astype(np.uint16), r100=r100.astype(np.uint16), r50_month=r50m,
        rx1day=np.clip(np.round(rx1 * 10), 0, 65535).astype(np.uint16),
        total=np.clip(np.round(total), 0, 65535).astype(np.uint16),
        lat=ref['lat'].astype(np.float32), lon=ref['lon'].astype(np.float32),
        info=np.array(json.dumps({'year': year, 'months': got, 'complete': len(got) == 12, 'days': days,
                                  'unit_detected': ref['unit'], 'dataset': DATASET,
                                  'statistic': 'daily_mean x 24 h, UTC days',
                                  'made': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ')})))
    log(f'{year}: saved {out.name} ({out.stat().st_size / 1e6:.1f} MB), months {got[0]}-{got[-1]}; '
        f'unit {ref["unit"]}; mean days >= 50 mm per cell {float(np.mean(r50)):.2f}; max {int(r50.max())}')
    return out


def git_commit(path: Path, message: str) -> None:
    """Commit and push one finished year, so a run that times out keeps its work."""
    def run(*cmd):
        return subprocess.run(cmd, cwd=ROOT, check=True, capture_output=True, text=True)
    run('git', 'add', str(path.relative_to(ROOT)))
    if subprocess.run(['git', 'diff', '--cached', '--quiet'], cwd=ROOT).returncode == 0:
        return
    run('git', 'commit', '-m', message)
    for attempt in range(3):
        try:
            run('git', 'pull', '--rebase', '--autostash')
            run('git', 'push')
            return
        except subprocess.CalledProcessError as e:
            log(f'  git push failed ({e.stderr.strip()[:200]}), retrying')
            time.sleep(10)
    raise SystemExit('Could not push the finished year')


def current_year_todo(year: int | None) -> tuple[int | None, list[int]]:
    """The unfinished year to show on its own, and the complete months still to download."""
    if not year:
        return None, []
    months = complete_months(year)
    if not months:
        return year, []
    path = YEARS_DIR / f'{year}.npz'
    have = read_year(path)['info'].get('months', []) if path.exists() else []
    return year, [m for m in months if m not in have]


def cmd_fetch(a):
    years = sorted(set(parse_period(a.period_a) + parse_period(a.period_b) + [int(y) for y in a.extra_years]))
    todo = [y for y in years if not (YEARS_DIR / f'{y}.npz').exists()]
    cy, cy_months = current_year_todo(a.current_year)
    log(f'Years needed: {years[0]}-{years[-1]} ({len(years)}); still to download: {todo or "none"}')
    if cy:
        log(f'Current year {cy}: complete months to download: {cy_months or "none"}')
    unfinished = [p for p in YEARS_DIR.glob('*.npz') if p.stem.isdigit() and int(p.stem) != cy
                  and not read_year(p)['info'].get('complete', True)]
    if not todo and not cy_months and not unfinished:
        return
    key = a.cds_key or os.environ.get('CDSAPI_KEY')
    if not key and not Path('~/.cdsapirc').expanduser().exists():
        raise SystemExit('No CDS token. Set CDSAPI_KEY (in GitHub: Settings > Secrets and variables > Actions). '
                         'Free token: https://cds.climate.copernicus.eu (profile page).')
    client = cds_client(key)
    t_start = time.time()
    done = []
    # The current year first: it is quick and it is the news.
    jobs = ([(cy, complete_months(cy))] if cy_months else []) + [(y, None) for y in todo]
    # An earlier year saved while it was still running (e.g. 2026, seen again in 2027): finish it.
    for p in sorted(YEARS_DIR.glob('*.npz')):
        y = int(p.stem) if p.stem.isdigit() else None
        if y and y != cy and not read_year(p)['info'].get('complete', True):
            jobs.insert(0, (y, complete_months(y)))
    for y, months in jobs:
        spent = (time.time() - t_start) / 60
        if done and spent + a.minutes_per_year > a.budget:
            log(f'Stopping after {spent:.0f} min to stay inside the time budget. Run again to continue.')
            break
        t0 = time.time()
        log(f'--- {y} ---')
        path = fetch_year(client, y, a.workers, a.keep, months)
        done.append(y)
        if months is None:
            a.minutes_per_year = max(a.minutes_per_year, (time.time() - t0) / 60)
        if a.git_commit:
            git_commit(path, f'ERA5 summary {y}' + (f' (months {months[0]}-{months[-1]})' if months else ''))
    left = [y for y in years if not (YEARS_DIR / f'{y}.npz').exists()]
    log(f'Done this run: {done}. Still missing: {left or "none"}')
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as f:
            f.write(f'### ERA5 download\n\nDownloaded this run: {", ".join(map(str, done)) or "none"}.\n\n'
                    + (f'**Still missing: {", ".join(map(str, left))}. Run the workflow again to continue.**\n'
                       if left else 'All years are in. The map data has been built.\n'))


# ---------------------------------------------------------------- 2. build

def load_years(years: list[int], months: list[int] | None = None) -> dict:
    """Yearly summaries stacked as (year, lat, lon). With `months`, also 'win': days >= 50 mm in those months only."""
    keys = ['r50', 'r100', 'rx1day', 'total'] + (['win'] if months else [])
    stacks = {k: [] for k in keys}
    lat = lon = None
    for y in years:
        z = np.load(YEARS_DIR / f'{y}.npz')
        for k in keys:
            if k == 'win':
                stacks[k].append(z['r50_month'][[m - 1 for m in months]].astype(np.uint16).sum(axis=0))
            else:
                stacks[k].append(z[k])
        lat, lon = z['lat'].astype(np.float64), z['lon'].astype(np.float64)
    out = {k: np.stack(v).astype(np.float32) for k, v in stacks.items()}
    out['rx1day'] /= 10
    # ERA5 longitudes run 0..360; put them in -180..180 order. Latitudes north to south.
    if lon.max() > 180:
        order = np.argsort(np.where(lon >= 180, lon - 360, lon))
        lon = np.where(lon >= 180, lon - 360, lon)[order]
        for k in keys:
            out[k] = out[k][:, :, order]
    if lat[0] < lat[-1]:
        lat = lat[::-1]
        for k in keys:
            out[k] = out[k][:, ::-1, :]
    out['lat'], out['lon'] = lat, lon
    return out


def coarsen(arr: np.ndarray, f: int) -> np.ndarray:
    """Mean over f x f blocks in the last two axes (drops the odd row at the South Pole)."""
    *lead, ny, nx = arr.shape
    ny2, nx2 = ny // f * f, nx // f * f
    a = arr[..., :ny2, :nx2].reshape(*lead, ny2 // f, f, nx2 // f, f)
    return a.mean(axis=(-3, -1))


def welch_p(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Two-sided p-value of Welch's t-test along axis 0, cell by cell. 1 where both periods are flat."""
    from scipy import stats
    with np.errstate(all='ignore'):
        res = stats.ttest_ind(b, a, axis=0, equal_var=False)
    p = np.asarray(res.pvalue, dtype=np.float64)
    return np.where(np.isfinite(p), p, 1.0)


def country_of(lon, lat):
    import shapely
    from shapely.geometry import shape
    fc = json.loads(download(NE_COUNTRIES, CACHE / 'ne' / 'countries.geojson').read_text())
    names = [f['properties']['NAME'] for f in fc['features']]
    conts = [f['properties']['CONTINENT'] for f in fc['features']]
    geoms = [shape(f['geometry']) for f in fc['features']]
    tree = shapely.STRtree(geoms)
    pts = shapely.points(lon, lat)
    idx = np.full(len(pts), -1)
    pi, gi = tree.query(pts, predicate='within')
    idx[pi] = gi
    miss = np.where(idx < 0)[0]
    if len(miss):  # coastal cells whose centre falls just offshore: nearest country within ~30 km
        pairs = tree.query_nearest(pts[miss], max_distance=0.3, all_matches=False)
        idx[miss[pairs[0]]] = pairs[1]
    name = np.array(names + [''], dtype=object)[idx]
    cont = np.array(conts + [''], dtype=object)[idx]
    # Natural Earth files French Guiana under France; a label "France" in South America would confuse readers.
    lon, lat = np.asarray(lon), np.asarray(lat)
    fg = (name == 'France') & (lon < -40) & (lon > -60) & (lat > 0) & (lat < 7)
    name[fg], cont[fg] = 'French Guiana', 'South America'
    return name, cont


def land_share(lon2d, lat2d, step):
    """Share of each grid cell that is land (Natural Earth 1:50m), from a 5 x 5 sample per cell."""
    import shapely
    from shapely.geometry import shape
    fc = json.loads(download(NE_LAND, CACHE / 'ne' / 'land.geojson').read_text())
    land = shapely.union_all([shape(f['geometry']) for f in fc['features']])
    shapely.prepare(land)
    offs = (np.arange(5) - 2) * step / 5
    acc = np.zeros(lon2d.shape, dtype=np.float32)
    for dx in offs:
        for dy in offs:
            acc += shapely.contains_xy(land, lon2d + dx, np.clip(lat2d + dy, -90, 90))
    return acc / 25


def pick_peaks(score, lon2d, lat2d, names, n, sep_deg, min_score):
    """Highest-scoring land cells at least sep_deg apart, one per country."""
    score = np.where(np.isfinite(score), score, -np.inf)  # NaN would sort first after reversing
    order = np.argsort(score, axis=None)[::-1]
    picked, used = [], set()
    for flat in order:
        s = score.flat[flat]
        if not np.isfinite(s) or s < min_score or len(picked) >= n:
            break
        name = names.flat[flat]
        if not name or name in used:
            continue
        x, y = lon2d.flat[flat], lat2d.flat[flat]
        if any(np.hypot((x - px + 180) % 360 - 180, y - py) < sep_deg for _, px, py in picked):
            continue
        picked.append((flat, x, y))
        used.add(name)
    return [f for f, _, _ in picked]


def cmd_build(a):
    ya, yb = parse_period(a.period_a), parse_period(a.period_b)
    missing = [y for y in ya + yb if not (YEARS_DIR / f'{y}.npz').exists()]
    if missing and not a.allow_partial:
        log(f'Not building yet: years still missing {missing}. Run fetch again.')
        return 0
    if missing:
        log(f'WARNING: building with missing years {missing} (--allow-partial). Do not publish this.')
        ya = [y for y in ya if y not in missing]
        yb = [y for y in yb if y not in missing]
    log(f'Building from {len(ya)} + {len(yb)} years ...')
    A, B = load_years(ya), load_years(yb)
    lat, lon = A['lat'], A['lon']
    native = float(abs(lat[1] - lat[0]))
    f = max(1, int(round(a.grid / native)))
    step = native * f
    # Cell centres of the coarse grid. ERA5 values are point values, so a block of f x f points
    # is centred half a native step inside its first point.
    clat = coarsen(lat[:, None] * np.ones((1, len(lon))), f)
    clon = coarsen(np.ones((len(lat), 1)) * lon[None, :], f)
    ny, nx = clat.shape
    log(f'Grid: native {native} deg, published {step} deg ({ny} x {nx})')

    ca = {k: coarsen(A[k], f) for k in ['r50', 'r100', 'rx1day', 'total']}
    cb = {k: coarsen(B[k], f) for k in ['r50', 'r100', 'rx1day', 'total']}
    ma = {k: v.mean(axis=0) for k, v in ca.items()}
    mb = {k: v.mean(axis=0) for k, v in cb.items()}
    p50 = welch_p(ca['r50'], cb['r50'])
    diff = mb['r50'] - ma['r50']

    # ------------------------------------------------ the unfinished current year, against the same months
    cur = None
    cpath = YEARS_DIR / f'{a.current_year}.npz' if a.current_year else None
    if cpath and cpath.exists() and a.current_year not in ya + yb:
        cm = read_year(cpath)['info']['months']
        cc = coarsen(load_years([a.current_year], cm)['win'][0], f)
        caw = coarsen(load_years(ya, cm)['win'], f)
        cbw = coarsen(load_years(yb, cm)['win'], f)
        cur = {'year': a.current_year, 'months': cm, 'count': cc, 'base_a': caw.mean(axis=0),
               'base_b': cbw.mean(axis=0), 'max_before': np.maximum(caw.max(axis=0), cbw.max(axis=0))}
        log(f'Current year {a.current_year}: months {cm[0]}-{cm[-1]}')
    zero = np.zeros_like(ma['r50'])
    c_count = cur['count'] if cur else zero
    c_base = cur['base_a'] if cur else zero
    c_record = (c_count > cur['max_before']) & (c_count >= 1) if cur else zero.astype(bool)

    area = np.cos(np.deg2rad(clat))
    landf = land_share(clon, clat, step)
    names, conts = country_of(clon.ravel(), clat.ravel())
    names = names.reshape(clat.shape)
    conts = conts.reshape(clat.shape)

    # ------------------------------------------------ globe data
    keep = (np.maximum(ma['r50'], mb['r50']) >= a.min_days) | (c_count >= 0.5)
    sig = np.where(p50 < 0.05, 2, np.where(p50 < 0.1, 1, 0))
    jj, ii = np.nonzero(keep)  # row (north to south), column (west to east)
    order = np.argsort(np.maximum(ma['r50'], mb['r50'])[jj, ii])
    jj, ii = jj[order], ii[order]
    flat = np.stack([ii, jj, np.round(ma['r50'][jj, ii] * 10), np.round(mb['r50'][jj, ii] * 10),
                     sig[jj, ii], np.round(landf[jj, ii] * 9), np.round(c_count[jj, ii] * 10),
                     np.round(c_base[jj, ii] * 10), c_record[jj, ii]], axis=1).astype(np.int64).ravel().tolist()

    def wmean(v, mask):
        w = area * mask
        return float((v * w).sum() / w.sum())

    def share(cond, mask):
        w = area * mask
        return round(100 * float((cond * w).sum() / w.sum()), 1)

    landm = (landf >= 0.5).astype(np.float32)
    seam = 1 - landm
    allm = np.ones_like(landm)
    wet = np.maximum(ma['r50'], mb['r50']) >= 1  # places where such days happen at least once a year
    meta = {
        'title': 'Days with extreme rainfall',
        'variable': 'days a year with at least 50 mm of precipitation (ERA5)',
        'threshold_mm': 50,
        'periods': {'a': [ya[0], ya[-1]], 'b': [yb[0], yb[-1]]},
        'years': {'a': ya, 'b': yb},
        'grid': step, 'origin': [float(clon[0, 0]), float(clat[0, 0])],
        'cells': int(len(jj)),
        'source': 'ERA5 post-processed daily statistics on single levels (Copernicus C3S / ECMWF), 0.25 deg, UTC days',
        'test': "Welch's t-test on yearly counts; sig 2 = p < 0.05, 1 = p < 0.1",
        'global': {
            'mean_days_land': [round(wmean(ma['r50'], landm), 3), round(wmean(mb['r50'], landm), 3)],
            'mean_days_ocean': [round(wmean(ma['r50'], seam), 3), round(wmean(mb['r50'], seam), 3)],
            'mean_days_all': [round(wmean(ma['r50'], allm), 3), round(wmean(mb['r50'], allm), 3)],
            'land_area_pct_with_1plus_day': [share(ma['r50'] >= 1, landm), share(mb['r50'] >= 1, landm)],
            'wet_land_pct_robust_increase': share((diff > 0) & (p50 < 0.05), landm * wet),
            'wet_land_pct_robust_decrease': share((diff < 0) & (p50 < 0.05), landm * wet),
            'wet_area_pct_robust_increase': share((diff > 0) & (p50 < 0.05), allm * wet),
            'wet_area_pct_robust_decrease': share((diff < 0) & (p50 < 0.05), allm * wet),
        },
        'current': None,
        'generated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'format': ('cells is a flat list of 9 numbers per cell: gi, gj, days a year x10 in period a, in period b, '
                   'sig (0-2), land share x9, current-year days x10 (complete months only), '
                   'period-a average for the same months x10, 1 if the current year beats every year of both periods. '
                   'lon = origin[0] + gi*grid, lat = origin[1] - gj*grid (cell centre)'),
    }
    if cur:
        cm = cur['months']
        mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        seen = (np.maximum(c_base, cur['base_b']) >= 0.3) | (c_count >= 1)  # places where such days happen
        meta['current'] = {
            'year': cur['year'], 'months': cm,
            'label': (mon[cm[0] - 1] + '–' + mon[cm[-1] - 1] if len(cm) > 1 else mon[cm[0] - 1]) + ' ' + str(cur['year']),
            'mean_days_land': [round(wmean(c_base, landm), 3), round(wmean(cur['base_b'], landm), 3),
                               round(wmean(c_count, landm), 3)],
            'land_pct_above_period_a': share(c_count > c_base, landm * seen),
            'land_pct_record': share(c_record, landm * seen),
        }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'rain.json').write_text(json.dumps({'meta': meta, 'cells': flat}, separators=(',', ':')))

    # ------------------------------------------------ labels
    labels = {}
    landok = (landf >= 0.5) & (names != '')
    for view, score, fmt in [
        ('a', np.where(landok, ma['r50'], np.nan), 'value'),
        ('b', np.where(landok, mb['r50'], np.nan), 'value'),
        ('change', np.where(landok & (p50 < 0.05) & (diff > 0), diff, np.nan), 'up'),
        ('change_down', np.where(landok & (p50 < 0.05) & (diff < 0), -diff, np.nan), 'down'),
    ] + ([('c', np.where(landok & (c_count >= 2), c_count - c_base, np.nan), 'value')] if cur else []):
        n = 3 if view == 'change_down' else 7
        idx = pick_peaks(score, clon, clat, names, n, a.label_sep, 0.5 if view != 'change' else 0.3)
        va, vb = (c_base, c_count) if view == 'c' else (ma['r50'], mb['r50'])
        labels[view] = [[names.flat[k], round(float(clon.flat[k]), 2), round(float(clat.flat[k]), 2),
                         round(float(va.flat[k]), 1), round(float(vb.flat[k]), 1)] for k in idx]
    labels['change'] = labels['change'] + labels.pop('change_down')
    (OUT / 'hotspots.json').write_text(json.dumps(labels, separators=(',', ':')))

    # ------------------------------------------------ statistics for the article
    by_year = {}
    extra = sorted(int(p.stem) for p in YEARS_DIR.glob('*.npz') if p.stem.isdigit())
    for y in sorted(set(ya + yb + extra)):
        if not read_year(YEARS_DIR / f'{y}.npz')['info'].get('complete', True):
            continue  # the unfinished year is reported under 'current'
        r = coarsen(load_years([y])['r50'][0], f)
        by_year[y] = {'mean_days_land': round(wmean(r, landm), 3), 'mean_days_ocean': round(wmean(r, seam), 3),
                      'land_area_pct_with_1plus_day': share(r >= 1, landm)}
    rows = []
    for c in sorted(set(names[landok].tolist())):
        m = landok & (names == c)
        w = area * m
        if w.sum() < a.min_country_cells * np.cos(np.deg2rad(30)):
            continue
        wm = lambda v: float((v * w).sum() / w.sum())
        rows.append({
            'country': c, 'continent': str(conts[m][0]), 'cells': int(m.sum()),
            'days_a': round(wm(ma['r50']), 2), 'days_b': round(wm(mb['r50']), 2),
            'change': round(wm(diff), 2), 'change_pct': round(100 * (wm(mb['r50']) / wm(ma['r50']) - 1), 1)
            if wm(ma['r50']) >= 0.2 else None,
            'pct_area_robust_increase': round(100 * float((((diff > 0) & (p50 < 0.05)) * w).sum() / w.sum()), 1),
            'pct_area_robust_decrease': round(100 * float((((diff < 0) & (p50 < 0.05)) * w).sum() / w.sum()), 1),
            'rx1day_a_mm': round(wm(ma['rx1day']), 1), 'rx1day_b_mm': round(wm(mb['rx1day']), 1),
            'total_a_mm': round(wm(ma['total'])), 'total_b_mm': round(wm(mb['total'])),
        })
    rows.sort(key=lambda r: -r['change'])
    cols = list(rows[0].keys()) if rows else []
    with open(OUT / 'rain-by-country.csv', 'w') as fh:
        fh.write(','.join(cols) + '\n')
        for r in rows:
            fh.write(','.join('"' + str(r[c]) + '"' if c in ('country', 'continent') else
                              ('' if r[c] is None else str(r[c])) for c in cols) + '\n')

    big = landok & (np.maximum(ma['r50'], mb['r50']) >= 1)
    top_up = np.argsort(np.where(big & (p50 < 0.05), diff, -np.inf), axis=None)[::-1][:15]
    top_down = np.argsort(np.where(big & (p50 < 0.05), diff, np.inf), axis=None)[:10]
    cell = lambda k: {'lon': round(float(clon.flat[k]), 2), 'lat': round(float(clat.flat[k]), 2),
                      'country': names.flat[k], 'days_a': round(float(ma['r50'].flat[k]), 1),
                      'days_b': round(float(mb['r50'].flat[k]), 1), 'p': round(float(p50.flat[k]), 4)}
    stats = {
        'meta': meta,
        'by_year': by_year,
        'days_100mm': {'mean_days_land': [round(wmean(ma['r100'], landm), 3), round(wmean(mb['r100'], landm), 3)]},
        'wettest_day_mm_land_mean': [round(wmean(ma['rx1day'], landm), 1), round(wmean(mb['rx1day'], landm), 1)],
        'annual_total_mm_land_mean': [round(wmean(ma['total'], landm)), round(wmean(mb['total'], landm))],
        'top_countries_increase': rows[:15],
        'top_countries_decrease': sorted(rows, key=lambda r: r['change'])[:10],
        'top_cells_increase': [cell(k) for k in top_up if np.isfinite(diff.flat[k])],
        'top_cells_decrease': [cell(k) for k in top_down if np.isfinite(diff.flat[k])],
        'current': None if not cur else {
            **meta['current'],
            'top_cells_above_usual': [
                {**cell(k), 'days_current': round(float(c_count.flat[k]), 1),
                 'usual_same_months_a': round(float(c_base.flat[k]), 1), 'record': bool(c_record.flat[k])}
                for k in np.argsort(np.where(landok & (c_count >= 1), c_count - c_base, -np.inf), axis=None)[::-1][:15]],
        },
        'note': ('About 5% of cells show a "robust" change at p < 0.05 by chance alone; '
                 'look for coherent regions rather than single cells.'),
    }
    (OUT / 'stats.json').write_text(json.dumps(stats, indent=1, default=str))
    size = (OUT / 'rain.json').stat().st_size / 1e6
    g = meta['global']
    log(f'Wrote rain.json ({len(jj):,} cells, {size:.1f} MB), hotspots.json, stats.json, rain-by-country.csv')
    log(f'Land mean days >= 50 mm: {g["mean_days_land"][0]} -> {g["mean_days_land"][1]}; '
        f'wet land with robust increase {g["wet_land_pct_robust_increase"]}%, decrease {g["wet_land_pct_robust_decrease"]}%')
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ['fetch', 'build']:
        p = sub.add_parser(name)
        p.add_argument('--period-a', default='2000-2010', help='first period, e.g. 2000-2010')
        p.add_argument('--period-b', default='2016-2025', help='second period, e.g. 2016-2025')
        p.add_argument('--current-year', type=int, default=dt.date.today().year,
                       help='unfinished year shown on its own, complete months only (default: this year; 0 = none)')
    f = sub.choices['fetch']
    f.add_argument('--extra-years', nargs='*', default=[], help='more years to download, e.g. 2011 2012')
    f.add_argument('--cds-key', help='CDS personal access token (or set CDSAPI_KEY, or use ~/.cdsapirc)')
    f.add_argument('--workers', type=int, default=1,
                   help='monthly requests sent to CDS at once (default 1: CDS rejects parallel requests to this dataset)')
    f.add_argument('--budget', type=float, default=1e9, help='stop starting new years after this many minutes')
    f.add_argument('--minutes-per-year', type=float, default=20, help='first guess of time per year, for --budget')
    f.add_argument('--git-commit', action='store_true', help='commit and push each finished year (GitHub Actions)')
    f.add_argument('--keep', action='store_true', help='keep the downloaded daily files in pipeline/cache/era5')
    b = sub.choices['build']
    b.add_argument('--grid', type=float, default=0.5, help='published grid in degrees (default 0.5)')
    b.add_argument('--min-days', type=float, default=0.1, help='leave out cells with fewer days a year in both periods')
    b.add_argument('--label-sep', type=float, default=12, help='minimum distance between labels, degrees')
    b.add_argument('--min-country-cells', type=int, default=4, help='smallest country in the CSV, in grid cells')
    b.add_argument('--allow-partial', action='store_true', help='build even if years are missing (for testing)')
    a = ap.parse_args()
    return cmd_fetch(a) if a.cmd == 'fetch' else cmd_build(a)


if __name__ == '__main__':
    sys.exit(main())
