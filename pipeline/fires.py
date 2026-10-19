"""
SpatialStat fire globe: download and clean NASA FIRMS fire detections.

What it does
  1. Downloads VIIRS NOAA-20 active-fire detections for the chosen period from the FIRMS API
     (5 days per request; near-real-time data, with the standard archive used where NRT is no longer kept).
     Or reads CSV files you downloaded yourself (--csv-dir).
  2. Keeps nominal- and high-confidence detections only.
  3. Removes detections that are not vegetation fires as far as open data allows:
       - offshore: more than about 5 km from land (oil and gas platforms);
       - settlements: inside towns and cities by the GHSL Degree of Urbanisation (GHS-SMOD 2025, 1 km);
       - persistent heat sources: the same ~400 m spot detected on many separate days
         (gas flares, industry, volcanoes).
  4. Bins the remaining detections into a grid (0.1 degree by default) with counts per calendar month,
     and writes the data for the globe plus summary statistics.

Run locally
  pip install -r pipeline/requirements.txt
  FIRMS_MAP_KEY=your_key python pipeline/fires.py --days 90
  # or, with files downloaded by hand:
  python pipeline/fires.py --csv-dir path/to/csv --start 2026-07-20 --end 2026-10-18

Outputs (in fire-globe/data/)
  fires.json              grid for the globe
  stats.json              numbers for the article
  fires-by-country.csv    detections per country, per month
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio
import shapely
from rasterio.windows import Window
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'pipeline' / 'cache'
OUT = ROOT / 'fire-globe' / 'data'

FIRMS = 'https://firms.modaps.eosdis.nasa.gov'
SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA20_SP']  # preferred first
GHSL_URL = ('https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_SMOD_GLOBE_R2023A/'
            'GHS_SMOD_E2025_GLOBE_R2023A_4326_30ss/V2-0/GHS_SMOD_E2025_GLOBE_R2023A_4326_30ss_V2_0.zip')
NE_COUNTRIES = ('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/'
                'ne_50m_admin_0_countries.geojson')
NE_LAND = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson'

# GHS-SMOD classes (Degree of Urbanisation, stage I)
SMOD = {30: 'Urban centre', 23: 'Dense urban cluster', 22: 'Semi-dense urban cluster',
        21: 'Suburban or peri-urban', 13: 'Rural cluster (village)', 12: 'Low density rural',
        11: 'Very low density rural', 10: 'Water'}


def log(*a):
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


# ---------------------------------------------------------------- 1. FIRMS data

def availability(key: str) -> dict[str, tuple[str, str]]:
    url = f'{FIRMS}/api/data_availability/csv/{key}/ALL'
    with urllib.request.urlopen(url, timeout=120) as r:
        df = pd.read_csv(io.StringIO(r.read().decode()))
    return {row.data_id: (str(row.min_date), str(row.max_date)) for row in df.itertuples()}


def fetch_api(key: str, start: dt.date, end: dt.date) -> pd.DataFrame:
    avail = availability(key)
    log('FIRMS availability:', {s: avail.get(s) for s in SOURCES})
    parts = []
    day = start
    while day <= end:
        n = min(5, (end - day).days + 1)
        last = day + dt.timedelta(days=n - 1)
        src = next((s for s in SOURCES if s in avail and avail[s][0] <= str(day) and str(last) <= avail[s][1]), None)
        if src is None:  # chunk straddles the NRT/SP boundary: fall back to 1-day requests
            src = SOURCES[0]
            if n > 1:
                for k in range(n):
                    parts.append(fetch_chunk(key, avail, day + dt.timedelta(days=k), 1))
                day = last + dt.timedelta(days=1)
                continue
        parts.append(fetch_chunk(key, avail, day, n, src))
        day = last + dt.timedelta(days=1)
    return pd.concat([p for p in parts if p is not None and len(p)], ignore_index=True)


def fetch_chunk(key, avail, day, n, src=None):
    if src is None:
        src = next((s for s in SOURCES if s in avail and avail[s][0] <= str(day) <= avail[s][1]), None)
        if src is None:
            log(f'  {day}: no data available, skipped')
            return None
    cache = CACHE / 'firms' / f'{src}_{day}_{n}d.csv'
    if not cache.exists():
        url = f'{FIRMS}/api/area/csv/{key}/{src}/world/{n}/{day}'
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=600) as r:
                    text = r.read().decode()
                break
            except Exception as e:  # network hiccup or rate limit: wait and retry
                log(f'  retry {attempt + 1}: {e}')
                time.sleep(30 * (attempt + 1))
        else:
            raise SystemExit(f'Could not download {src} {day}')
        if not text.startswith('latitude'):
            raise SystemExit(f'FIRMS answered: {text[:200]}')
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(text)
    df = pd.read_csv(cache)
    log(f'  {src} {day} +{n}d: {len(df):,} detections')
    return df


def read_csv_dir(folder: Path) -> pd.DataFrame:
    files = sorted(folder.glob('*.csv'))
    if not files:
        raise SystemExit(f'No CSV files in {folder}')
    return pd.concat([pd.read_csv(f) for f in files], ignore_index=True)


# ---------------------------------------------------------------- 2. masks

def settlement_class(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """GHS-SMOD class at each point, read in strips so memory stays small."""
    zpath = download(GHSL_URL, CACHE / 'ghsl' / GHSL_URL.split('/')[-1])
    tif = next((p for p in zpath.parent.glob('*.tif')), None)
    if tif is None:
        with zipfile.ZipFile(zpath) as z:
            name = next(n for n in z.namelist() if n.lower().endswith('.tif'))
            z.extract(name, zpath.parent)
        tif = zpath.parent / name
    out = np.full(len(lon), -200, dtype=np.int16)
    with rasterio.open(tif) as src:
        inv = ~src.transform
        cols, rows = inv * (lon, lat)
        cols = np.floor(cols).astype(np.int64)
        rows = np.floor(rows).astype(np.int64)
        ok = (cols >= 0) & (cols < src.width) & (rows >= 0) & (rows < src.height)
        strip = 1024
        for r0 in range(0, src.height, strip):
            sel = ok & (rows >= r0) & (rows < r0 + strip)
            if not sel.any():
                continue
            h = min(strip, src.height - r0)
            block = src.read(1, window=Window(0, r0, src.width, h))
            out[sel] = block[rows[sel] - r0, cols[sel]]
    return out


def persistent(df: pd.DataFrame, min_days: int) -> np.ndarray:
    """True where the same ~400 m spot burns on at least min_days separate days."""
    key = (np.round(df['longitude'].to_numpy() / 0.004).astype(np.int64) * 100000
           + np.round(df['latitude'].to_numpy() / 0.004).astype(np.int64))
    days = pd.DataFrame({'k': key, 'd': df['acq_date'].to_numpy()}).drop_duplicates()
    counts = days['k'].value_counts()
    return (pd.Series(key).map(counts).to_numpy() >= min_days)


def countries(lon, lat):
    """Country name and continent (Natural Earth 1:50m); nearest country for coastal points."""
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
    if len(miss):
        # nearest country within ~10 km, for points on coasts that the 1:50m outlines miss
        pairs = tree.query_nearest(pts[miss], max_distance=0.1, all_matches=False)
        idx[miss[pairs[0]]] = pairs[1]
    name = np.array(names + ['Unassigned'], dtype=object)[idx]
    cont = np.array(conts + ['Unassigned'], dtype=object)[idx]
    return name, cont


def near_land(lon, lat, km=5):
    fc = json.loads(download(NE_LAND, CACHE / 'ne' / 'land.geojson').read_text())
    land = shapely.union_all([shape(f['geometry']) for f in fc['features']])
    buf = shapely.buffer(land, km / 111.0)
    shapely.prepare(buf)
    return shapely.contains_xy(buf, lon, lat)


# ---------------------------------------------------------------- 3. labels for the globe

def write_hotspots(df: pd.DataFrame, months: list[str], top: int = 8) -> None:
    """Top countries per period, labelled at their busiest 1-degree cell: fire-globe/data/hotspots.json."""
    df = df[df['country'] != 'Unassigned'].assign(
        x=np.floor(df['longitude']) + 0.5, y=np.floor(df['latitude']) + 0.5)
    out = {}
    for period in ['all'] + months:
        d = df if period == 'all' else df[df['month'] == period]
        if d.empty:
            continue
        counts = d['country'].value_counts().head(top)
        rows = []
        for name, n in counts.items():
            peak = d[d['country'] == name].groupby(['x', 'y']).size().idxmax()
            rows.append([name, int(n), float(peak[0]), float(peak[1])])
        out[period] = rows
    (OUT / 'hotspots.json').write_text(json.dumps(out, separators=(',', ':')))


# ---------------------------------------------------------------- 4. run

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--days', type=int, default=90, help='period length, ending yesterday (UTC) unless --end is set')
    ap.add_argument('--start', help='first day, YYYY-MM-DD')
    ap.add_argument('--end', help='last day, YYYY-MM-DD')
    ap.add_argument('--csv-dir', help='use CSV files from this folder instead of the API')
    ap.add_argument('--map-key', default=os.environ.get('FIRMS_MAP_KEY'), help='FIRMS MAP_KEY (or set FIRMS_MAP_KEY)')
    ap.add_argument('--drop-villages', action='store_true', help='also remove rural clusters (villages)')
    ap.add_argument('--persistent-share', type=float, default=0.2,
                    help='a spot is a static heat source if it burns on at least this share of days (default 0.2)')
    ap.add_argument('--grid', type=float, default=0.1, help='grid size in degrees (default 0.1)')
    ap.add_argument('--max-cells', type=int, default=220_000, help='coarsen the grid if there are more cells')
    a = ap.parse_args()

    end = dt.date.fromisoformat(a.end) if a.end else dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)
    start = dt.date.fromisoformat(a.start) if a.start else end - dt.timedelta(days=a.days - 1)
    days = (end - start).days + 1
    log(f'Period: {start} to {end} ({days} days)')

    if a.csv_dir:
        df = read_csv_dir(Path(a.csv_dir))
    else:
        if not a.map_key:
            raise SystemExit('Set FIRMS_MAP_KEY (free: https://firms.modaps.eosdis.nasa.gov/api/map_key/) or use --csv-dir')
        df = fetch_api(a.map_key, start, end)

    df = df.drop_duplicates(subset=['latitude', 'longitude', 'acq_date', 'acq_time'])
    df = df[(df['acq_date'] >= str(start)) & (df['acq_date'] <= str(end))].reset_index(drop=True)
    counts = {'downloaded': int(len(df))}
    conf = df['confidence'].astype(str).str.lower().str[0]
    df = df[conf.isin(['n', 'h'])].reset_index(drop=True)
    counts['after_confidence'] = int(len(df))
    lon, lat = df['longitude'].to_numpy(), df['latitude'].to_numpy()

    log('Masking offshore detections ...')
    land = near_land(lon, lat)
    log('Masking settlements (GHS-SMOD 2025) ...')
    smod = settlement_class(lon, lat)
    urban_min = 13 if a.drop_villages else 21
    urban = smod >= urban_min
    min_days = max(5, round(days * a.persistent_share))
    log(f'Masking persistent heat sources (same spot on {min_days}+ days) ...')
    static = persistent(df, min_days)

    removed = {
        'offshore': int((~land).sum()),
        'settlements': int((land & urban).sum()),
        'persistent_heat_sources': int((land & ~urban & static).sum()),
    }
    removed_by_class = {SMOD.get(int(k), str(k)): int(v)
                        for k, v in pd.Series(smod[land & urban]).value_counts().items()}
    keep = land & ~urban & ~static
    df = df[keep].reset_index(drop=True)
    counts['final'] = int(len(df))
    log(f'Kept {counts["final"]:,} of {counts["after_confidence"]:,} detections; removed {removed}')

    log('Assigning countries ...')
    df['country'], df['continent'] = countries(df['longitude'].to_numpy(), df['latitude'].to_numpy())
    # Natural Earth puts all of Russia in Europe; east of the Urals (60°E) count it as Asia.
    df.loc[(df['country'] == 'Russia') & (df['longitude'] > 60), 'continent'] = 'Asia'
    df['month'] = df['acq_date'].str[:7]
    months = sorted(df['month'].unique())

    # Grid for the globe
    grid = a.grid
    while True:
        gi = np.floor((df['longitude'] + 180) / grid).astype(int)
        gj = np.floor((df['latitude'] + 90) / grid).astype(int)
        ncells = len(set(zip(gi, gj)))
        if ncells <= a.max_cells:
            break
        grid = round(grid * 2, 4)
        log(f'  {ncells:,} cells: coarsening grid to {grid} degrees')
    df['gi'], df['gj'] = gi, gj
    tab = df.pivot_table(index=['gi', 'gj'], columns='month', values='frp', aggfunc='size', fill_value=0)
    tab = tab.reindex(columns=months, fill_value=0)
    tab['total'] = tab[months].sum(axis=1)
    tab = tab.sort_values('total').reset_index()
    flat = tab[['gi', 'gj'] + months].to_numpy(dtype=np.int64).ravel().tolist()

    meta = {
        'title': 'Fire detections on Earth',
        'start': str(start), 'end': str(end), 'days': days, 'months': months,
        'grid': grid, 'cells': int(len(tab)), 'detections': counts['final'],
        'satellite': 'NOAA-20 (JPSS-1), VIIRS 375 m', 'sources_used': sorted(df['satellite'].astype(str).unique().tolist()),
        'counts': counts, 'removed': removed,
        'masks': {
            'confidence': 'nominal and high only',
            'offshore': 'more than 5 km from land (Natural Earth 1:50m)',
            'settlements': f'GHS-SMOD 2025 class {urban_min} and above',
            'persistent': f'same ~400 m spot on {min_days}+ days',
        },
        'generated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'format': 'cells is a flat list: gi, gj, then one count per month; lon = gi*grid-180, lat = gj*grid-90 (cell corner)',
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'fires.json').write_text(json.dumps({'meta': meta, 'cells': flat}, separators=(',', ':')))

    # Statistics for the article
    total = len(df)
    pct = lambda v: round(100 * v / total, 1)
    by_country = df['country'].value_counts()
    by_cont = df['continent'].value_counts()
    weekly = df.assign(w=pd.to_datetime(df['acq_date']).dt.to_period('W-SUN').astype(str)).groupby('w').size()
    cells1 = (df.assign(x=np.floor(df['longitude']), y=np.floor(df['latitude']))
                .groupby(['x', 'y']).agg(n=('frp', 'size'), country=('country', lambda s: s.mode()[0]))
                .sort_values('n', ascending=False).head(15).reset_index())
    stats = {
        'meta': meta,
        'removed_settlements_by_class': removed_by_class,
        'by_month': df['month'].value_counts().sort_index().to_dict(),
        'by_week': weekly.to_dict(),
        'by_continent': {k: [int(v), pct(v)] for k, v in by_cont.items()},
        'top_countries': {k: [int(v), pct(v)] for k, v in by_country.head(25).items()},
        'top_countries_by_month': {m: df[df['month'] == m]['country'].value_counts().head(5).to_dict() for m in months},
        'top_1deg_cells': cells1.to_dict(orient='records'),
        'hemisphere': {'north': int((df['latitude'] >= 0).sum()), 'south': int((df['latitude'] < 0).sum())},
        'day_night': df['daynight'].value_counts().to_dict(),
        'countries_with_fires': int(df.loc[df['country'] != 'Unassigned', 'country'].nunique()),
    }
    (OUT / 'stats.json').write_text(json.dumps(stats, indent=1, default=str))
    (df.pivot_table(index=['country', 'continent'], columns='month', values='frp', aggfunc='size', fill_value=0)
       .assign(total=lambda t: t.sum(axis=1)).sort_values('total', ascending=False)
       .to_csv(OUT / 'fires-by-country.csv'))
    write_hotspots(df[['longitude', 'latitude', 'country', 'month']], months)
    size = (OUT / 'fires.json').stat().st_size / 1e6
    log(f'Wrote {OUT / "fires.json"} ({len(tab):,} cells, {size:.1f} MB), stats.json, fires-by-country.csv')


if __name__ == '__main__':
    sys.exit(main())
