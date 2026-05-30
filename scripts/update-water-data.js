const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const OLD_API_URL = 'http://api.vandudsigten.dk/beaches';
const BADEVAND_URL = 'https://badevand.dk/';

const dataDir = path.join(process.cwd(), 'data');
const beachesPath = path.join(dataDir, 'beaches.json');
const lastUpdatePath = path.join(dataDir, 'last-update.json');
const debugDir = path.join(process.cwd(), 'debug');
const networkDebugPath = path.join(debugDir, 'badevand-network-candidates.json');

function ensureDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(debugDir, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readPreviousBeaches() {
  try {
    if (!fs.existsSync(beachesPath)) return [];
    const data = JSON.parse(fs.readFileSync(beachesPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function requestText(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      family: 4,
      timeout: timeoutMs,
      headers: {
        'Accept': 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 GitHubActions cphwater/1.0'
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${body.slice(0, 200)}`));
          return;
        }
        resolve(body);
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms for ${url}`));
    });

    req.on('error', reject);
    req.end();
  });
}

function parseJsonArray(text, sourceLabel) {
  if (!text || text.trim().startsWith('<')) {
    throw new Error(`${sourceLabel} returned HTML or empty response`);
  }
  const json = JSON.parse(text);
  if (!Array.isArray(json)) {
    throw new Error(`${sourceLabel} returned JSON but not an array`);
  }
  return json;
}

function looksLikeBeachObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj).map(k => k.toLowerCase());
  const hasName = keys.includes('name') || keys.includes('beachname') || keys.includes('title');
  const hasId = keys.includes('id') || keys.includes('beachid') || keys.includes('stationid');
  const hasMeasurements = Array.isArray(obj.data) || keys.some(k =>
    ['water_quality','waterquality','bathingwaterquality','water_temperature','watertemperature','wind_speed','windspeed'].includes(k)
  );
  return hasName && (hasId || hasMeasurements);
}

function collectBeachArrays(value, found = []) {
  if (!value) return found;

  if (Array.isArray(value)) {
    const beachLikeCount = value.filter(looksLikeBeachObject).length;
    if (value.length > 0 && beachLikeCount >= Math.max(1, Math.ceil(value.length * 0.35))) {
      found.push(value);
    }
    for (const item of value) collectBeachArrays(item, found);
    return found;
  }

  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectBeachArrays(v, found);
  }

  return found;
}

async function fetchFromOldApi() {
  const text = await requestText(OLD_API_URL);
  return parseJsonArray(text, 'old API');
}

async function fetchBySniffingBadevand() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (error) {
    throw new Error('Playwright is not installed. Workflow must run npm install playwright. Original error: ' + error.message);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  });

  const candidates = [];

  page.on('response', async (response) => {
    const url = response.url();
    const headers = response.headers();
    const contentType = headers['content-type'] || '';

    if (!/json|api|forecast|beach|bade|vand/i.test(url + ' ' + contentType)) return;

    try {
      const text = await response.text();
      if (!text || text.trim().startsWith('<')) return;
      const json = JSON.parse(text);
      const arrays = collectBeachArrays(json);
      candidates.push({
        url,
        status: response.status(),
        contentType,
        arraysFound: arrays.length,
        json
      });
    } catch {
      // Ignore non-JSON responses.
    }
  });

  try {
    await page.goto(BADEVAND_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(15000);
  } finally {
    await browser.close();
  }

  writeJson(networkDebugPath, candidates.map(c => ({
    url: c.url,
    status: c.status,
    contentType: c.contentType,
    arraysFound: c.arraysFound
  })));

  const allArrays = [];
  for (const candidate of candidates) {
    allArrays.push(...collectBeachArrays(candidate.json));
  }

  if (allArrays.length === 0) {
    throw new Error('No beach-like JSON arrays found while sniffing badevand.dk. See debug/badevand-network-candidates.json');
  }

  allArrays.sort((a, b) => b.length - a.length);
  return allArrays[0];
}

async function main() {
  ensureDirs();
  const now = new Date();
  const attempts = [];

  try {
    let beaches;
    let source;

    try {
      beaches = await fetchFromOldApi();
      source = OLD_API_URL;
      attempts.push({ source: 'old-api', status: 'success', records: beaches.length });
    } catch (error) {
      attempts.push({ source: 'old-api', status: 'error', error: error.message });
      beaches = await fetchBySniffingBadevand();
      source = BADEVAND_URL + ' network-sniff';
      attempts.push({ source: 'badevand-network-sniff', status: 'success', records: beaches.length });
    }

    if (!Array.isArray(beaches) || beaches.length === 0) {
      throw new Error('No records returned from available sources');
    }

    writeJson(beachesPath, beaches);
    writeJson(lastUpdatePath, {
      status: 'success',
      updated_at_utc: now.toISOString(),
      source,
      records: beaches.length,
      attempts
    });

    console.log(`Water data updated successfully. Records: ${beaches.length}. Source: ${source}`);
  } catch (error) {
    const previous = readPreviousBeaches();

    if (!fs.existsSync(beachesPath)) {
      writeJson(beachesPath, []);
    }

    writeJson(lastUpdatePath, {
      status: 'error',
      updated_at_utc: now.toISOString(),
      source: OLD_API_URL,
      error: error.message,
      previous_data_available: previous.length > 0,
      previous_records: previous.length,
      attempts
    });

    console.error('Water data update failed:', error.message);
    process.exit(1);
  }
}

main();
