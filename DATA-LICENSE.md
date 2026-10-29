# Licences and credits

## Code
The code in this repository (HTML, CSS, JavaScript and the Python pipeline) is released under the MIT licence; see `LICENSE`.
Bundled libraries keep their own licences: d3-geo and d3-array (ISC, `shared/vendor/`).

## Maps
The map designs and images are © SpatialStat and published under
[Creative Commons BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/).
Embedding the interactive maps on a non-commercial site is welcome, with the credit line visible.
For news media, books, reports, adaptations and commercial use, see https://spatialstat.com/licensing/.

## Processed data
`fire-globe/data/fires.json`, `stats.json` and `fires-by-country.csv`, and `rain-globe/data/rain.json`, `stats.json`,
`hotspots.json` and `rain-by-country.csv` (with the yearly summaries in `pipeline/era5-years/`) are available under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Please credit SpatialStat and the original sources below.

## Original data

| Data | Provider | Licence | Credit |
| --- | --- | --- | --- |
| VIIRS 375 m active fire detections, NOAA-20 (NRT and standard) | NASA FIRMS / LANCE | NASA open data, no restrictions on use | We acknowledge the use of data and imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Earth Science Data and Information System (ESDIS). |
| GHS-SMOD R2023A, epoch 2025, 30 arc-seconds (Degree of Urbanisation) | European Commission, Joint Research Centre | CC BY 4.0, © European Union | Schiavina M., Melchiorri M., Pesaresi M. (2023): GHS-SMOD R2023A. European Commission, Joint Research Centre. Changes: used as a mask to remove fire detections in towns and cities. |
| ERA5 post-processed daily statistics on single levels (total precipitation, daily mean of hourly values, 0.25°) | Copernicus Climate Change Service (C3S) / ECMWF | CC BY 4.0 | Generated using Copernicus Climate Change Service information (2026). Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains. Hersbach, H. et al. (2020): The ERA5 global reanalysis. Q. J. R. Meteorol. Soc. 146, 1999–2049. Changes: daily totals counted against 50 mm and 100 mm thresholds and averaged over 2000–2010 and 2016–2025. |
| Admin 0 countries, land, boundary lines, 1:50m | Natural Earth | Public domain | Made with Natural Earth. |
| Blue Marble satellite image of the Earth (`shared/base/blue-marble-*.jpg`) | NASA Visible Earth | Public domain (NASA imagery) | NASA Visible Earth, Blue Marble. Shows the land surface, not conditions on the dates of the fire data. |

## How the data were changed
Low-confidence detections were removed. Detections more than about 5 km from land, inside GHS-SMOD classes 21–30
(suburban, urban clusters and urban centres), or at the same ~400 m spot on many separate days (gas flares, industry, volcanoes)
were removed. The rest were counted on a regular latitude–longitude grid per calendar month.
FIRMS data are provided without warranty; detections are satellite observations, not confirmed fires on the ground.

ERA5 (rain globe): daily totals were computed from the dataset's daily mean of hourly precipitation (UTC days), counted per year
(days with at least 50 mm and 100 mm, wettest day, yearly total), averaged over each period and aggregated from 0.25° to 0.5°.
ERA5 is a model reanalysis and underestimates local extremes compared with rain gauges.
