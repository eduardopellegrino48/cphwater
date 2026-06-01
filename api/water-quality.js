const ORIGINAL_ENDPOINT = "http://api.vandudsigten.dk/doc/beaches";

const VANDUDSIGTEN_ENDPOINTS = [
    "https://api.vandudsigten.dk/doc/beaches",
    "http://api.vandudsigten.dk/doc/beaches",
    "https://api.allorigins.win/raw?url=" + encodeURIComponent(ORIGINAL_ENDPOINT),
    "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(ORIGINAL_ENDPOINT)
];

const SPOTS = [
    {
        id: "nordhavn",
        label: "NORDHAVN",
        lat: 55.7069,
        lon: 12.5976
    },
    {
        id: "refshaleoen",
        label: "REFSHALEØEN",
        lat: 55.6939,
        lon: 12.6098
    },
    {
        id: "indre-by",
        label: "INDRE BY",
        lat: 55.6749,
        lon: 12.5794
    },
    {
        id: "islands-brygge",
        label: "ISLANDS BRYGGE",
        lat: 55.6648,
        lon: 12.5773
    },
    {
        id: "amager",
        label: "AMAGER STRANDPARK",
        lat: 55.6546,
        lon: 12.6480
    },
    {
        id: "kbh-sv",
        label: "KØBENHAVN SV",
        lat: 55.6471,
        lon: 12.5442
    }
];

function round1(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function toRad(value) {
    return value * Math.PI / 180;
}

function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseDateSafe(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function getArrayByPossibleNames(data, names) {
    for (const name of names) {
        if (Array.isArray(data?.[name])) {
            return data[name];
        }
    }

    return [];
}

function latestMeasurementForBeach(measurements, beachId) {
    const rows = measurements
        .filter(row => Number(row.id) === Number(beachId))
        .filter(row => row.water_quality !== undefined && row.water_quality !== null);

    if (!rows.length) return null;

    rows.sort((a, b) => {
        const da = parseDateSafe(a.date)?.getTime() ?? 0;
        const db = parseDateSafe(b.date)?.getTime() ?? 0;
        return db - da;
    });

    return rows[0];
}

function findNearestBeach(spot, overview) {
    const candidates = overview
        .filter(beach =>
            Number.isFinite(Number(beach.latitude)) &&
            Number.isFinite(Number(beach.longitude))
        )
        .map(beach => ({
            ...beach,
            distance: distanceKm(
                spot.lat,
                spot.lon,
                Number(beach.latitude),
                Number(beach.longitude)
            )
        }))
        .sort((a, b) => a.distance - b.distance);

    return candidates[0] || null;
}

function normalizeWaterQuality(value) {
    const q = Number(value);

    if (!Number.isFinite(q)) {
        return {
            value: null,
            label: "Unknown",
            status: "unknown"
        };
    }

    if (q === 1) {
        return {
            value: q,
            label: "Bad",
            status: "bad"
        };
    }

    if (q === 2) {
        return {
            value: q,
            label: "Good",
            status: "good"
        };
    }

    if (q === 3) {
        return {
            value: q,
            label: "Warning",
            status: "warning"
        };
    }

    if (q === 4) {
        return {
            value: q,
            label: "No data",
            status: "unknown"
        };
    }

    return {
        value: q,
        label: "Unknown",
        status: "unknown"
    };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });

        return response;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchVandudsigten() {
    const attempts = [];

    for (const endpoint of VANDUDSIGTEN_ENDPOINTS) {
        try {
            const response = await fetchWithTimeout(endpoint, {
                headers: {
                    "Accept": "application/json,text/plain,*/*",
                    "User-Agent": "Copenhagen-Water-Index/1.0"
                }
            });

            const contentType = response.headers.get("content-type") || "";
            const text = await response.text();

            attempts.push({
                endpoint,
                status: response.status,
                ok: response.ok,
                content_type: contentType,
                preview: text.slice(0, 500)
            });

            if (!response.ok) {
                continue;
            }

            let data;

            try {
                data = JSON.parse(text);
            } catch (jsonError) {
                attempts[attempts.length - 1].json_error = jsonError.message;
                continue;
            }

            return {
                data,
                attempts
            };

        } catch (error) {
            attempts.push({
                endpoint,
                error: error.name === "AbortError" ? "timeout" : error.message
            });
        }
    }

    return {
        data: null,
        attempts
    };
}

function buildFallbackSpots() {
    return SPOTS.map(spot => ({
        id: spot.id,
        label: spot.label,
        water_quality: null,
        water_quality_label: "Unknown",
        water_quality_status: "unknown",
        source_beach_id: null,
        source_beach_name: null,
        source_distance_km: null,
        source_date: null
    }));
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "GET") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    const debugMode = req.query?.debug === "1";

    try {
        const fetched = await fetchVandudsigten();

        if (!fetched.data) {
            return res.status(500).json({
                source: "Vandudsigten",
                generated_at: new Date().toISOString(),
                error: "Unable to retrieve valid JSON from Vandudsigten",
                quality_count: 0,
                debug: fetched.attempts,
                spots: buildFallbackSpots()
            });
        }

        const data = fetched.data;

        const overview = getArrayByPossibleNames(data, [
            "overview",
            "beaches",
            "Beach",
            "beach"
        ]);

        const measurements = getArrayByPossibleNames(data, [
            "meassurements",
            "measurements",
            "measurement",
            "Measure",
            "measures"
        ]);

        const spots = SPOTS.map(spot => {
            const nearestBeach = findNearestBeach(spot, overview);
            const latest = nearestBeach
                ? latestMeasurementForBeach(measurements, nearestBeach.id)
                : null;

            const normalized = normalizeWaterQuality(latest?.water_quality);

            return {
                id: spot.id,
                label: spot.label,

                water_quality: normalized.value,
                water_quality_label: normalized.label,
                water_quality_status: normalized.status,

                source_beach_id: nearestBeach?.id ?? null,
                source_beach_name: nearestBeach?.name ?? null,
                source_distance_km: nearestBeach ? round1(nearestBeach.distance) : null,
                source_date: latest?.date ?? null
            };
        });

        res.setHeader(
            "Cache-Control",
            "s-maxage=60, stale-while-revalidate=300"
        );

        const payload = {
            source: "Vandudsigten",
            generated_at: new Date().toISOString(),
            overview_count: overview.length,
            measurements_count: measurements.length,
            quality_count: spots.filter(spot => spot.water_quality !== null).length,
            spots
        };

        if (debugMode) {
            payload.debug = {
                fetch_attempts: fetched.attempts,
                top_level_keys: Object.keys(data || {}),
                overview_sample: overview.slice(0, 5),
                measurements_sample: measurements.slice(0, 5)
            };
        }

        return res.status(200).json(payload);

    } catch (error) {
        console.error("Water quality API error:", error);

        return res.status(500).json({
            source: "Vandudsigten",
            generated_at: new Date().toISOString(),
            error: "Unable to retrieve water quality data",
            details: error.message,
            quality_count: 0,
            spots: buildFallbackSpots()
        });
    }
}
