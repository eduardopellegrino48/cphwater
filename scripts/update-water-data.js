const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(process.cwd(), "data");
const REPORT_PATH = path.join(OUTPUT_DIR, "water-report.json");
const LAST_UPDATE_PATH = path.join(OUTPUT_DIR, "last-update.json");

const SPOTS = [
    {
        id: "nordhavn",
        name: "NORDHAVN",
        latitude: 55.7082,
        longitude: 12.5985
    },
    {
        id: "refshaleoen",
        name: "REFSHALEØEN",
        latitude: 55.6936,
        longitude: 12.6128
    },
    {
        id: "indre-by",
        name: "INDRE BY",
        latitude: 55.6741,
        longitude: 12.5789
    },
    {
        id: "islands-brygge",
        name: "ISLANDS BRYGGE",
        latitude: 55.6635,
        longitude: 12.5794
    },
    {
        id: "amager-strandpark",
        name: "AMAGER STRANDPARK",
        latitude: 55.6565,
        longitude: 12.6412
    },
    {
        id: "kbh-sv",
        name: "KØBENHAVN SV",
        latitude: 55.6485,
        longitude: 12.5485
    }
];

function ensureOutputDir() {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
}

function roundOrNull(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.round(number);
}

function roundOneOrNull(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.round(number * 10) / 10;
}

function loadPreviousReport() {
    if (!fs.existsSync(REPORT_PATH)) return null;

    try {
        return JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
    } catch {
        return null;
    }
}

function getNearestHourlyValue(hourly, variableName) {
    if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly[variableName])) {
        return null;
    }

    const now = new Date();
    let bestIndex = -1;
    let bestDistance = Infinity;

    hourly.time.forEach((timeValue, index) => {
        const time = new Date(timeValue);
        if (Number.isNaN(time.getTime())) return;

        const distance = Math.abs(time.getTime() - now.getTime());
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    });

    if (bestIndex === -1) return null;

    const value = hourly[variableName][bestIndex];
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

async function fetchJson(url) {
    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Accept": "application/json",
            "User-Agent": "cphwater-github-actions/1.0"
        }
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return response.json();
}

async function fetchSpotData(spot) {
    const latitude = encodeURIComponent(spot.latitude);
    const longitude = encodeURIComponent(spot.longitude);

    const weatherUrl =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${latitude}` +
        `&longitude=${longitude}` +
        `&current=temperature_2m,wind_speed_10m` +
        `&wind_speed_unit=ms` +
        `&timezone=Europe%2FCopenhagen`;

    /*
      Open-Meteo Marine API. The sea_surface_temperature variable is used when available.
      If the model does not return it for a point, the page keeps Water as "--°C"
      but still publishes Air and Wind.
    */
    const marineUrl =
        `https://marine-api.open-meteo.com/v1/marine` +
        `?latitude=${latitude}` +
        `&longitude=${longitude}` +
        `&hourly=sea_surface_temperature` +
        `&timezone=Europe%2FCopenhagen` +
        `&forecast_days=1`;

    let weather = null;
    let marine = null;
    let errors = [];

    try {
        weather = await fetchJson(weatherUrl);
    } catch (error) {
        errors.push(`weather: ${error.message}`);
    }

    try {
        marine = await fetchJson(marineUrl);
    } catch (error) {
        errors.push(`marine: ${error.message}`);
    }

    const airTemperature = roundOrNull(weather?.current?.temperature_2m);
    const windSpeed = roundOneOrNull(weather?.current?.wind_speed_10m);
    const waterTemperature = roundOrNull(
        getNearestHourlyValue(marine?.hourly, "sea_surface_temperature")
    );

    const dataAvailable =
        airTemperature !== null ||
        windSpeed !== null ||
        waterTemperature !== null;

    return {
        id: spot.id,
        name: spot.name,
        latitude: spot.latitude,
        longitude: spot.longitude,
        status: dataAvailable ? "live" : "unavailable",
        water_temperature: waterTemperature,
        air_temperature: airTemperature,
        wind_speed: windSpeed,
        source: {
            weather: "Open-Meteo Forecast API",
            marine: "Open-Meteo Marine API"
        },
        errors
    };
}

async function main() {
    ensureOutputDir();

    const now = new Date();
    const previousReport = loadPreviousReport();

    try {
        const spots = [];

        for (const spot of SPOTS) {
            console.log(`Fetching ${spot.name}...`);
            const spotData = await fetchSpotData(spot);
            spots.push(spotData);
            console.log(spotData);
        }

        const validCount = spots.filter(spot => spot.status === "live").length;

        if (validCount === 0) {
            throw new Error("No live data returned by Open-Meteo");
        }

        const report = {
            status: "success",
            updated_at_utc: now.toISOString(),
            updated_at_copenhagen: now.toLocaleString("sv-SE", {
                timeZone: "Europe/Copenhagen"
            }),
            note: "Weather and marine-condition data. This is not official bacteriological bathing-water quality.",
            sources: [
                "https://api.open-meteo.com/v1/forecast",
                "https://marine-api.open-meteo.com/v1/marine"
            ],
            spots
        };

        fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

        fs.writeFileSync(
            LAST_UPDATE_PATH,
            JSON.stringify(
                {
                    status: "success",
                    updated_at_utc: now.toISOString(),
                    records: spots.length,
                    live_records: validCount
                },
                null,
                2
            ),
            "utf8"
        );

        console.log(`Report updated successfully. Live spots: ${validCount}/${spots.length}`);

    } catch (error) {
        console.error("Update failed:", error.message);

        const fallbackReport = previousReport || {
            status: "error",
            updated_at_utc: now.toISOString(),
            updated_at_copenhagen: now.toLocaleString("sv-SE", {
                timeZone: "Europe/Copenhagen"
            }),
            note: "No data available yet.",
            sources: [
                "https://api.open-meteo.com/v1/forecast",
                "https://marine-api.open-meteo.com/v1/marine"
            ],
            spots: SPOTS.map(spot => ({
                ...spot,
                status: "unavailable",
                water_temperature: null,
                air_temperature: null,
                wind_speed: null,
                source: {
                    weather: "Open-Meteo Forecast API",
                    marine: "Open-Meteo Marine API"
                },
                errors: [error.message]
            }))
        };

        fallbackReport.status = "error";
        fallbackReport.last_error = error.message;
        fallbackReport.error_at_utc = now.toISOString();

        fs.writeFileSync(REPORT_PATH, JSON.stringify(fallbackReport, null, 2), "utf8");

        fs.writeFileSync(
            LAST_UPDATE_PATH,
            JSON.stringify(
                {
                    status: "error",
                    updated_at_utc: now.toISOString(),
                    error: error.message,
                    previous_data_available: Boolean(previousReport)
                },
                null,
                2
            ),
            "utf8"
        );

        /*
          Do not fail the workflow if previous data exists.
          This keeps GitHub Pages serving the latest available report.
        */
        process.exit(0);
    }
}

main();
