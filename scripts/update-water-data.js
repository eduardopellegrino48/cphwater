const fs = require("fs");
const path = require("path");

const API_URL = "http://api.vandudsigten.dk/beaches";

const dataDir = path.join(process.cwd(), "data");
const beachesPath = path.join(dataDir, "beaches.json");
const lastUpdatePath = path.join(dataDir, "last-update.json");

async function main() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const now = new Date();

    try {
        const response = await fetch(API_URL, {
            method: "GET",
            headers: {
                "Accept": "application/json,text/plain,*/*",
                "User-Agent": "Mozilla/5.0 GitHubActions"
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }

        const text = await response.text();

        if (!text || text.trim().startsWith("<")) {
            throw new Error("API returned non-JSON response");
        }

        const json = JSON.parse(text);

        if (!Array.isArray(json)) {
            throw new Error("Unexpected API structure: response is not an array");
        }

        fs.writeFileSync(beachesPath, JSON.stringify(json, null, 2), "utf8");

        fs.writeFileSync(
            lastUpdatePath,
            JSON.stringify(
                {
                    status: "success",
                    updated_at_utc: now.toISOString(),
                    source: API_URL,
                    records: json.length
                },
                null,
                2
            ),
            "utf8"
        );

        console.log(`Water data updated successfully. Records: ${json.length}`);

    } catch (error) {
        console.error("Water data update failed:", error.message);

        const previousDataExists = fs.existsSync(beachesPath);

        fs.writeFileSync(
            lastUpdatePath,
            JSON.stringify(
                {
                    status: "error",
                    updated_at_utc: now.toISOString(),
                    source: API_URL,
                    error: error.message,
                    previous_data_available: previousDataExists
                },
                null,
                2
            ),
            "utf8"
        );

        if (!previousDataExists) {
            fs.writeFileSync(beachesPath, JSON.stringify([], null, 2), "utf8");
        }

        process.exit(0);
    }
}

main();
