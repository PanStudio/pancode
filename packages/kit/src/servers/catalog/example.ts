// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The catalog file `pankit catalog --example` prints: one `local` source and
 * one `ckan` source, every field the parser takes for each, so a newcomer can
 * write a valid file on the first try. It parses as is; replace the values.
 */
export const CATALOG_EXAMPLE = `{
	"version": 1,
	"sources": [
		{
			"id": "site",
			"type": "local",
			"datasets": [
				{
					"id": "climate-2024",
					"title": "Regional climate runs 2024",
					"description": "Daily fields, 12 km grid.",
					"tags": ["climate", "netcdf"],
					"license": "CC-BY-4.0",
					"updated": "2024-05-01T12:00:00Z",
					"resources": [
						{ "id": "tas", "name": "tas_day.nc", "format": "NetCDF", "path": "/data/climate/tas_day.nc", "sha256": null }
					]
				}
			]
		},
		{
			"id": "open",
			"type": "ckan",
			"url": "https://catalog.example.org",
			"resourceHosts": ["files.example.org"]
		}
	]
}
`;
