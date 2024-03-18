const fs = require('fs');
const https = require('https');
const zlib = require('zlib');
const tar = require('tar');
const path = require('path');
const { getAccountId, getLicense, getSelectedDbs } = require('../utils');

let licenseKey;
try {
  licenseKey = getLicense();
} catch (e) {
  console.error('geolite2: Error retrieving Maxmind License Key');
  console.error(e.message);
}

let accountId;
try {
  accountId = getAccountId();
} catch (e) {
  console.error('geolite2: Error retrieving Maxmind Account ID');
  console.error(e.message);
}

if (!licenseKey) {
  console.error(`Error: License Key is not configured.\n
  You need to signup for a _free_ Maxmind account to get a license key.
  Go to https://www.maxmind.com/en/geolite2/signup, obtain your account ID and
  license key and put them in the MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY
  environment variables.

  If you do not have access to env vars, put this config in your package.json
  file (at the root level) like this:

  "geolite2": {
    // specify the account id
    "account-id": "<your account id>",
    // specify the key
    "license-key": "<your license key>",
    // ... or specify the file where key is located:
    "license-file": "maxmind-licence.key"
  }
`);
  process.exit(1);
}

// If an account ID is set, use the new URL path with Basic auth.
// Otherwise, fall back to the legacy URL path with license key as query parameter.
const link = (edition) =>
  accountId
    ? `https://download.maxmind.com/geoip/databases/${edition}/download?suffix=tar.gz`
    : `https://download.maxmind.com/app/geoip_download?edition_id=${edition}&license_key=${licenseKey}&suffix=tar.gz`;

const selected = getSelectedDbs();
const editionIds = ['City', 'Country', 'ASN']
  .filter((e) => selected.includes(e))
  .map((e) => `GeoLite2-${e}`);

const downloadPath = path.join(__dirname, '..', 'dbs');

if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);

const request = async (url, options) => {
  const response = await new Promise((resolve, reject) => {
    https
      .request(
        url,
        {
          auth: accountId ? `${accountId}:${licenseKey}` : null,
          ...options,
        },
        (response) => {
          resolve(response);
        }
      )
      .on('error', (err) => reject(err))
      .end();
  });

  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    // Handle redirect
    return request(response.headers.location, {
      ...options,
      auth: null
    });
  }

  if (response.statusCode !== 200) {
    throw new Error(`Request failed to ${url} - ${response.statusCode} ${response.statusMessage}`);
  }

  return response;
};

// https://dev.maxmind.com/geoip/updating-databases?lang=en#checking-for-the-latest-release-date
const isOutdated = async (dbPath, url) => {
  if (!fs.existsSync(dbPath)) return true;

  const response = await request(url, { method: 'HEAD' });
  const remoteLastModified = Date.parse(response.headers['last-modified']);
  const localLastModified = fs.statSync(dbPath).mtimeMs;

  return localLastModified < remoteLastModified;
};

const main = async () => {
  console.log('Downloading maxmind databases...');
  for (const editionId of editionIds) {
    const dbPath = path.join(downloadPath, `${editionId}.mmdb`);
    const isOutdatedStatus = await isOutdated(dbPath, link(editionId));

    if (!isOutdatedStatus) {
      console.log(' > %s: Is up to date, skipping download', editionId);
      continue;
    }
    console.log(' > %s: Is either missing or outdated, downloading', editionId);

    const response = await request(link(editionId));
    const entryPromises = [];
    await new Promise((resolve, reject) => response
      .pipe(zlib.createGunzip())
      .pipe(tar.t())
      .on('entry', (entry) => {
        if (entry.path.endsWith('.mmdb')) {
          const dstFilename = path.join(downloadPath, path.basename(entry.path));
          console.log(`writing ${dstFilename} ...`);
          entryPromises.push(new Promise((resolve, reject) => {
            entry.pipe(fs.createWriteStream(dstFilename)).on('finish', resolve).on('error', reject);
          }));
        }
      })
      .on('end', resolve)
      .on('error', reject)
    );
    await Promise.all(entryPromises);
  }
};

main()
  .then(() => {
    // success
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
