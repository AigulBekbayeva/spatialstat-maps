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
`fire-globe/data/fires.json`, `stats.json` and `fires-by-country.csv` are available under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Please credit SpatialStat and the original sources below.

## Original data

| Data | Provider | Licence | Credit |
| --- | --- | --- | --- |
| VIIRS 375 m active fire detections, NOAA-20 (NRT and standard) | NASA FIRMS / LANCE | NASA open data, no restrictions on use | We acknowledge the use of data and imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Earth Science Data and Information System (ESDIS). |
| GHS-SMOD R2023A, epoch 2025, 30 arc-seconds (Degree of Urbanisation) | European Commission, Joint Research Centre | CC BY 4.0, © European Union | Schiavina M., Melchiorri M., Pesaresi M. (2023): GHS-SMOD R2023A. European Commission, Joint Research Centre. Changes: used as a mask to remove fire detections in towns and cities. |
| Admin 0 countries, land, boundary lines, 1:50m | Natural Earth | Public domain | Made with Natural Earth. |

## How the data were changed
Low-confidence detections were removed. Detections more than about 5 km from land, inside GHS-SMOD classes 21–30
(suburban, urban clusters and urban centres), or at the same ~400 m spot on many separate days (gas flares, industry, volcanoes)
were removed. The rest were counted on a regular latitude–longitude grid per calendar month.
FIRMS data are provided without warranty; detections are satellite observations, not confirmed fires on the ground.
