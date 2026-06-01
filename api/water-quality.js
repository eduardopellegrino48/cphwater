const VANDUDSIGTEN_ENDPOINT = "http://api.vandudsigten.dk/doc/beaches";

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

    try {
        const response = await fetch(VANDUDSIGTEN_ENDPOINT, {
            headers: {
                "Accept": "application/json",
                "User-Agent": "Copenhagen-Water-Index/1.0"
            }
        });

        if (!response.ok) {
            throw new Error(`Vandudsigten HTTP ${response.status}`);
        }

        const data = await response.json();

        const overview = Array.isArray(data?.overview) ? data.overview : [];
        const measurements = Array.isArray(data?.meassurements)
            ? data.meassurements
            : Array.isArray(data?.measurements)
                ? data.measurements
                : [];

        if (!overview.length || !measurements.length) {
            throw new Error("Invalid Vandudsigten response structure");
        }

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

        return res.status(200).json({
            source: "Vandudsigten",
            generated_at: new Date().toISOString(),
            spots
        });

    } catch (error) {
        console.error("Water quality API error:", error);

        return res.status(500).json({
            source: "Vandudsigten",
            generated_at: new Date().toISOString(),
            error: "Unable to retrieve water quality data",
            details: error.message,
            spots: SPOTS.map(spot => ({
                id: spot.id,
                label: spot.label,
                water_quality: null,
                water_quality_label: "Unknown",
                water_quality_status: "unknown",
                source_beach_id: null,
                source_beach_name: null,
                source_distance_km: null,
                source_date: null
            }))
        });
    }
}
