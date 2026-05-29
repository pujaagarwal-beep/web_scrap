const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// -----------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------
const SEARCH_KEYWORD   = 'cable';
const NUM_TO_SCRAPE    = 5;

// -----------------------------------------------------------------------
// CSV HEADERS
// -----------------------------------------------------------------------
const HEADERS = [
    "Portal","Keyword","Site Link","S.No","e-Published Date","Closing Date","Opening Date",
    "Title","Tender Ref No","Tender ID","Organisation Chain","Organisation Chain (Detail)",
    "Tender Reference Number","Withdrawal Allowed","Tender Type","Form Of Contract",
    "General Technical Evaluation Allowed","ItemWise Technical Evaluation Allowed","Payment Mode",
    "Is Multi Currency Allowed For BOQ","Is Multi Currency Allowed For Fee","Allow Two Stage Bidding",
    "Tender Category","No. of Covers","Tender Fee (INR)","Fee Payable To","Fee Payable At",
    "Tender Fee Exemption Allowed","EMD Amount (INR)","EMD through BG/ST or EMD Exemption Allowed",
    "EMD Fee Type","EMD Percentage","EMD Payable To","EMD Payable At","Title (Detail)",
    "Work Description","NDA/Pre Qualification","Independent External Monitor/Remarks",
    "Tender Value (INR)","Effective Tender Value (INR)","Value Source","Value Status",
    "Product Category","Sub category","Contract Type","Bid Validity(Days)","Period Of Work(Days)",
    "Location","Pincode","Pre Bid Meeting Place","Pre Bid Meeting Address","Pre Bid Meeting Date",
    "Bid Opening Place","Should Allow NDA Tender","Allow Preferential Bidder","Published Date",
    "Bid Opening Date","Document Download / Sale Start Date","Document Download / Sale End Date",
    "Clarification Start Date","Clarification End Date","Bid Submission Start Date",
    "Bid Submission End Date","Name","Address","Tender Folder Path","NIT PDF Path",
    "ZIP File Path","ZIP Extracted Folder Path","Downloaded Files"
];

// -----------------------------------------------------------------------
// Chrome Profile & Preferences Setup
// -----------------------------------------------------------------------
const userDataDir = path.join(__dirname, 'chrome_user_data');
const prefsDir    = path.join(userDataDir, 'Default');
if (!fs.existsSync(prefsDir)) {
    fs.mkdirSync(prefsDir, { recursive: true });
}
const prefsPath = path.join(prefsDir, 'Preferences');
let prefs = {};
if (fs.existsSync(prefsPath)) {
    try {
        prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    } catch (e) {}
}

if (!prefs.plugins) prefs.plugins = {};
prefs.plugins.always_open_pdf_externally = true;

if (!prefs.profile) prefs.profile = {};
if (!prefs.profile.default_content_setting_values) prefs.profile.default_content_setting_values = {};
prefs.profile.default_content_setting_values.multiple_automatic_downloads = 1;

if (!prefs.download) prefs.download = {};
prefs.download.prompt_for_download = false;

fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));

// -----------------------------------------------------------------------
// Manual Captcha Solver & Downloader Loop
// -----------------------------------------------------------------------
async function handleManualCaptchaAndDownload(page, downloadDir) {
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir
    });

    console.log('\n=============================================================');
    console.log('[ACTION REQUIRED] PLEASE ENTER THE CAPTCHA IN THE BROWSER WINDOW');
    console.log('AND CLICK THE SUBMIT BUTTON.');
    console.log('=============================================================\n');

    const beforeFiles = new Set(fs.readdirSync(downloadDir));

    while (true) {
        // Poll for new downloaded file
        const currentFiles = fs.readdirSync(downloadDir);
        const newFiles = currentFiles.filter(f => !beforeFiles.has(f));
        if (newFiles.length > 0) {
            const isDownloading = newFiles.some(f => f.endsWith('.crdownload') || f.endsWith('.tmp'));
            if (!isDownloading) {
                const finishedFile = newFiles.find(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
                if (finishedFile) {
                    return path.join(downloadDir, finishedFile);
                }
            }
        }

        // Check if still on captcha page
        const stillOnCaptchaPage = await page.evaluate(() => {
            return !!document.querySelector('#captchaText');
        }).catch(() => false);

        if (!stillOnCaptchaPage) {
            // We navigated away! Wait up to 30 seconds for any active download to complete
            const extraPollStart = Date.now();
            while (Date.now() - extraPollStart < 30000) {
                const currentFiles = fs.readdirSync(downloadDir);
                const newFiles = currentFiles.filter(f => !beforeFiles.has(f));
                if (newFiles.length > 0) {
                    const isDownloading = newFiles.some(f => f.endsWith('.crdownload') || f.endsWith('.tmp'));
                    if (!isDownloading) {
                        const finishedFile = newFiles.find(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
                        if (finishedFile) {
                            return path.join(downloadDir, finishedFile);
                        }
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            break;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return null;
}

// -----------------------------------------------------------------------
// ZIP Extraction Helper
// -----------------------------------------------------------------------
function extractZipWindows(zipPath, destDir) {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const zp = zipPath.replace(/'/g, "''");
    const dp = destDir.replace(/'/g, "''");
    execSync(`powershell -Command "Expand-Archive -Path '${zp}' -DestinationPath '${dp}' -Force"`, { stdio: 'ignore' });
}

// -----------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------
(async () => {
    console.log('Starting browser...');
    const browser = await puppeteer.launch({
        headless: false,
        userDataDir,
        defaultViewport: { width: 1366, height: 768 }
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    try {
        const portalUrl = 'https://wbtenders.gov.in';

        // ── Search ────────────────────────────────────────────────────────
        console.log('Navigating to WB Tenders homepage...');
        await page.goto(`${portalUrl}/nicgep/app`, { waitUntil: 'networkidle2' });

        console.log(`Searching for "${SEARCH_KEYWORD}"...`);
        await page.waitForSelector('#SearchDescription');
        await page.type('#SearchDescription', SEARCH_KEYWORD);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click('#Go')
        ]);

        await page.waitForFunction(
            () => Array.from(document.querySelectorAll('td,th')).some(c => c.innerText.includes('Title and Ref.No./Tender ID')),
            { timeout: 20000 }
        );
        console.log('Results table found. Starting extraction...\n');

        const scrapedData = [];

        // ── Loop ──────────────────────────────────────────────────────────
        for (let i = 0; i < NUM_TO_SCRAPE; i++) {
            console.log(`--- Tender ${i + 1} of ${NUM_TO_SCRAPE} ---`);

            await page.waitForFunction(
                () => Array.from(document.querySelectorAll('td,th')).some(c => c.innerText.includes('Title and Ref.No./Tender ID')),
                { timeout: 60000 }
            );

            // Extract row info
            const listInfo = await page.evaluate((index) => {
                const tbl = Array.from(document.querySelectorAll('table'))
                    .find(t => t.innerText.includes('Title and Ref.No./Tender ID'));
                if (!tbl) return null;
                const dataRows = Array.from(tbl.querySelectorAll('tr')).filter(r => {
                    const cells = r.querySelectorAll('td');
                    return cells.length >= 6 && /^\d+\.?$/.test(cells[0].innerText.trim());
                });
                if (index >= dataRows.length) return null;
                const row = dataRows[index];
                const cells = row.querySelectorAll('td');
                const aTag = row.querySelector('a[id^="DirectLink_"]');
                return aTag ? {
                    linkId:       aTag.id,
                    sNo:          cells[0].innerText.trim().replace('.', ''),
                    ePubDate:     cells[1].innerText.trim(),
                    closingDate:  cells[2].innerText.trim(),
                    openingDate:  cells[3].innerText.trim(),
                    titleAndRef:  cells[4].innerText.trim(),
                    orgChainList: cells[5].innerText.trim()
                } : null;
            }, i);

            if (!listInfo) { console.log('  No more rows.'); break; }

            // Parse title/ref/id
            let title = listInfo.titleAndRef, refNo = '', tenderId = '';
            const parts = title.match(/\[(.*?)\]/g);
            if (parts && parts.length >= 3) {
                title    = parts[0].replace(/\[|\]/g,'').trim();
                refNo    = parts[1].replace(/\[|\]/g,'').trim();
                tenderId = parts[2].replace(/\[|\]/g,'').trim();
            } else if (parts && parts.length >= 2) {
                title = parts[0].replace(/\[|\]/g,'').trim();
                refNo = parts[1].replace(/\[|\]/g,'').trim();
            }
            console.log(`  Tender ID: ${tenderId || listInfo.linkId}`);

            // Navigate to detail page
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2' }),
                page.click(`#${listInfo.linkId}`)
            ]);
            const detailPageUrl = page.url();

            // Extract detail key-value pairs
            const details = await page.evaluate(() => {
                const data = {};
                const cells = document.querySelectorAll('td');
                for (let j = 0; j < cells.length - 1; j++) {
                    const key = (cells[j].innerText || '').trim().replace(/:$/, '').trim();
                    if (key) data[key] = (cells[j + 1].innerText || '').trim();
                }
                return data;
            });

            const finalTenderId = details['Tender ID'] || tenderId;
            const tenderFolder  = path.join(__dirname, 'downloads', finalTenderId);
            if (!fs.existsSync(tenderFolder)) fs.mkdirSync(tenderFolder, { recursive: true });

            let nitPdfPath = '', zipFilePath = '', zipExtractedPath = '';
            const downloadedFilesList = [];

            // Configure download behavior
            const client = await page.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: tenderFolder
            });

            // ── Download NIT PDF ─────────────────────────────────────────
            const nitId = await page.evaluate(() => {
                const nit = Array.from(document.querySelectorAll('a')).find(a =>
                    (a.id && a.id.toLowerCase().includes('docdown')) ||
                    (a.href && a.href.toLowerCase().includes('docdown')) ||
                    (a.innerText && a.innerText.trim().toLowerCase().endsWith('.pdf')) ||
                    (a.innerText && a.innerText.toLowerCase().includes('tendernotice'))
                );
                if (!nit) return null;
                if (!nit.id) {
                    nit.id = 'temp_nit_download_link';
                }
                return nit.id;
            });

            if (nitId) {
                console.log(`  NIT PDF found: "${nitId}" — initiating download...`);
                const finalPdfName = `${finalTenderId}-NIT.pdf`;
                const finalPdfPath = path.join(tenderFolder, finalPdfName);
                
                try {
                    const beforeFiles = new Set(fs.readdirSync(tenderFolder));
                    
                    // Simply click the link
                    await page.click(`#${nitId}`);

                    // Wait for either captcha page to render or direct download to start/finish
                    let onCaptchaPage = false;
                    let tmpPdf = null;
                    const pollStart = Date.now();
                    while (Date.now() - pollStart < 45000) {
                        const hasCaptcha = await page.evaluate(() => {
                            return !!document.querySelector('#captchaText');
                        }).catch(() => false);

                        if (hasCaptcha) {
                            onCaptchaPage = true;
                            break;
                        }

                        const currentFiles = fs.readdirSync(tenderFolder);
                        const newFiles = currentFiles.filter(f => !beforeFiles.has(f));
                        if (newFiles.length > 0) {
                            const isDownloading = newFiles.some(f => f.endsWith('.crdownload') || f.endsWith('.tmp'));
                            if (!isDownloading) {
                                const finishedFile = newFiles.find(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
                                if (finishedFile) {
                                    tmpPdf = path.join(tenderFolder, finishedFile);
                                    break;
                                }
                            }
                        }
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }

                    if (onCaptchaPage) {
                        tmpPdf = await handleManualCaptchaAndDownload(page, tenderFolder);
                    }

                    if (tmpPdf) {
                        fs.renameSync(tmpPdf, finalPdfPath);
                        nitPdfPath = finalPdfPath;
                        downloadedFilesList.push(finalPdfName);
                        console.log(`  ✓ NIT PDF saved: ${finalPdfName} (${Math.round(fs.statSync(finalPdfPath).size/1024)} KB)`);
                    } else {
                        console.log('  ✗ NIT PDF failed: Download timed out, skipped or cancelled.');
                    }
                } catch (e) {
                    console.warn(`  ✗ NIT PDF failed: ${e.message}`);
                }

                if (page.url() !== detailPageUrl) {
                    await page.goto(detailPageUrl, { waitUntil: 'networkidle2' });
                }
            } else {
                console.log('  NIT PDF link not found (documents may not be available yet).');
            }

            // ── Download ZIP ─────────────────────────────────────────────
            const zipId = await page.evaluate(() => {
                const zip = Array.from(document.querySelectorAll('a'))
                    .find(a => a.innerText && a.innerText.toLowerCase().includes('download as zip'));
                if (!zip) return null;
                if (!zip.id) {
                    zip.id = 'temp_zip_download_link';
                }
                return zip.id;
            });

            if (zipId) {
                console.log(`  ZIP found: "${zipId}" — initiating download...`);
                const finalZipName = `${finalTenderId}-ZIP.zip`;
                const finalZipDir  = `${finalTenderId}-ZIP`;
                const finalZipPath = path.join(tenderFolder, finalZipName);
                zipExtractedPath   = path.join(tenderFolder, finalZipDir);

                try {
                    const beforeFiles = new Set(fs.readdirSync(tenderFolder));

                    // Simply click the link
                    await page.click(`#${zipId}`);

                    // Wait for either captcha page to render or direct download to start/finish
                    let onCaptchaPage = false;
                    let tmpZip = null;
                    const pollStart = Date.now();
                    while (Date.now() - pollStart < 45000) {
                        const hasCaptcha = await page.evaluate(() => {
                            return !!document.querySelector('#captchaText');
                        }).catch(() => false);

                        if (hasCaptcha) {
                            onCaptchaPage = true;
                            break;
                        }

                        const currentFiles = fs.readdirSync(tenderFolder);
                        const newFiles = currentFiles.filter(f => !beforeFiles.has(f));
                        if (newFiles.length > 0) {
                            const isDownloading = newFiles.some(f => f.endsWith('.crdownload') || f.endsWith('.tmp'));
                            if (!isDownloading) {
                                const finishedFile = newFiles.find(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
                                if (finishedFile) {
                                    tmpZip = path.join(tenderFolder, finishedFile);
                                    break;
                                }
                            }
                        }
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }

                    if (onCaptchaPage) {
                        tmpZip = await handleManualCaptchaAndDownload(page, tenderFolder);
                    }

                    if (tmpZip) {
                        fs.renameSync(tmpZip, finalZipPath);
                        zipFilePath = finalZipPath;
                        downloadedFilesList.push(finalZipName);
                        extractZipWindows(zipFilePath, zipExtractedPath);
                        downloadedFilesList.push(finalZipDir);
                        console.log(`  ✓ ZIP saved & extracted: ${finalZipName} (${Math.round(fs.statSync(finalZipPath).size/1024)} KB)`);
                    } else {
                        console.log('  ✗ ZIP failed: Download skipped or cancelled.');
                    }
                } catch (e) {
                    console.warn(`  ✗ ZIP failed: ${e.message}`);
                    zipFilePath = '';
                    zipExtractedPath = '';
                }

                if (page.url() !== detailPageUrl) {
                    await page.goto(detailPageUrl, { waitUntil: 'networkidle2' });
                }
            } else {
                console.log('  ZIP link not found (documents may not be available yet).');
            }

            // ── Map to CSV row ───────────────────────────────────────────
            const rowData = {};
            HEADERS.forEach(h => rowData[h] = '');

            rowData['Portal']             = portalUrl;
            rowData['Keyword']            = SEARCH_KEYWORD;
            rowData['Site Link']          = detailPageUrl;
            rowData['S.No']               = listInfo.sNo;
            rowData['e-Published Date']   = listInfo.ePubDate;
            rowData['Closing Date']       = listInfo.closingDate;
            rowData['Opening Date']       = listInfo.openingDate;
            rowData['Title']              = title;
            rowData['Tender Ref No']      = refNo;
            rowData['Tender ID']          = finalTenderId;
            rowData['Organisation Chain'] = listInfo.orgChainList;

            rowData['Organisation Chain (Detail)']            = details['Organisation Chain']           || '';
            rowData['Tender Reference Number']                = details['Tender Reference Number']       || '';
            rowData['Withdrawal Allowed']                     = details['Withdrawal Allowed']             || '';
            rowData['Tender Type']                            = details['Tender Type']                   || '';
            rowData['Form Of Contract']                       = details['Form Of Contract']              || '';
            rowData['General Technical Evaluation Allowed']   = details['General Technical Evaluation Allowed'] || '';
            rowData['ItemWise Technical Evaluation Allowed']  = details['ItemWise Technical Evaluation Allowed'] || '';
            rowData['Payment Mode']                           = details['Payment Mode']                  || '';
            rowData['Is Multi Currency Allowed For BOQ']      = details['Is Multi Currency Allowed For BOQ'] || '';
            rowData['Is Multi Currency Allowed For Fee']      = details['Is Multi Currency Allowed For Fee'] || '';
            rowData['Allow Two Stage Bidding']                = details['Allow Two Stage Bidding']       || '';
            rowData['Tender Category']                        = details['Tender Category']               || '';
            rowData['No. of Covers']                          = details['No. of Covers']                 || '';
            rowData['Tender Fee (INR)']                       = details['Tender Fee in ₹'] || details['Tender Fee in \u20b9'] || '';
            rowData['Fee Payable To']                         = details['Fee Payable To']                || '';
            rowData['Fee Payable At']                         = details['Fee Payable At']                || '';
            rowData['Tender Fee Exemption Allowed']           = details['Tender Fee Exemption Allowed']  || '';
            rowData['EMD Amount (INR)']                       = details['EMD Amount in ₹'] || details['EMD Amount in \u20b9'] || '';
            rowData['EMD through BG/ST or EMD Exemption Allowed'] = details['EMD Exemption Allowed']   || '';
            rowData['EMD Fee Type']                           = details['EMD Fee Type']                  || '';
            rowData['EMD Percentage']                         = details['EMD Percentage']               || '';
            rowData['EMD Payable To']                         = details['EMD Payable To']               || '';
            rowData['EMD Payable At']                         = details['EMD Payable At']               || '';
            rowData['Title (Detail)']                         = details['Title']                         || '';
            rowData['Work Description']                       = details['Work Description']              || '';
            rowData['NDA/Pre Qualification']                  = details['NDA/Pre Qualification']        || '';
            rowData['Independent External Monitor/Remarks']   = details['Independent External Monitor/Remarks'] || '';
            rowData['Tender Value (INR)']                     = details['Tender Value in ₹'] || details['Tender Value in \u20b9'] || '';

            const tVal = (rowData['Tender Value (INR)'] || '').replace(/,/g,'');
            rowData['Effective Tender Value (INR)'] = tVal;
            rowData['Value Source']                 = 'Tender Value';
            rowData['Value Status']                 = 'direct';

            rowData['Product Category']             = details['Product Category']          || '';
            rowData['Sub category']                 = details['Sub category']              || '';
            rowData['Contract Type']                = details['Contract Type']             || '';
            rowData['Bid Validity(Days)']           = details['Bid Validity(Days)']        || '';
            rowData['Period Of Work(Days)']         = details['Period Of Work(Days)']      || '';
            rowData['Location']                     = details['Location']                  || '';
            rowData['Pincode']                      = details['Pincode']                   || '';
            rowData['Pre Bid Meeting Place']        = details['Pre Bid Meeting Place']     || '';
            rowData['Pre Bid Meeting Address']      = details['Pre Bid Meeting Address']   || '';
            rowData['Pre Bid Meeting Date']         = details['Pre Bid Meeting Date']      || '';
            rowData['Bid Opening Place']            = details['Bid Opening Place']         || '';
            rowData['Should Allow NDA Tender']      = details['Should Allow NDA Tender']   || '';
            rowData['Allow Preferential Bidder']    = details['Allow Preferential Bidder'] || '';
            rowData['Published Date']               = details['Published Date']            || '';
            rowData['Bid Opening Date']             = details['Bid Opening Date']          || '';
            rowData['Document Download / Sale Start Date'] = details['Document Download / Sale Start Date'] || '';
            rowData['Document Download / Sale End Date']   = details['Document Download / Sale End Date']   || '';
            rowData['Clarification Start Date']     = details['Clarification Start Date']  || '';
            rowData['Clarification End Date']       = details['Clarification End Date']    || '';
            rowData['Bid Submission Start Date']    = details['Bid Submission Start Date'] || '';
            rowData['Bid Submission End Date']      = details['Bid Submission End Date']   || '';
            rowData['Name']                         = details['Name']                      || '';
            rowData['Address']                      = details['Address']                   || '';

            rowData['Tender Folder Path']        = tenderFolder;
            rowData['NIT PDF Path']              = nitPdfPath;
            rowData['ZIP File Path']             = zipFilePath;
            rowData['ZIP Extracted Folder Path'] = zipExtractedPath;
            rowData['Downloaded Files']          = downloadedFilesList.join(', ');

            scrapedData.push(rowData);

            // ── Return to list via Back button ─────────────────────────────
            console.log('  Clicking Back to return to list page...');
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2' }),
                page.click('#DirectLink_11')
            ]);
            console.log('');
        }

        // ── Write CSV ─────────────────────────────────────────────────────
        const outputPath = path.join(__dirname, 'wbtenders_formatted.csv');
        console.log(`Saving ${scrapedData.length} rows to ${outputPath}...`);

        if (scrapedData.length > 0) {
            const csvLines = [HEADERS.map(h => `"${h}"`).join(',')];
            scrapedData.forEach(row => {
                csvLines.push(
                    HEADERS.map(h => `"${(row[h] || '').toString().replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`).join(',')
                );
            });
            fs.writeFileSync(outputPath, csvLines.join('\n'));
            console.log('SUCCESS! CSV saved.');

            // ── Write XLSX ────────────────────────────────────────────────
            const xlsxPath = path.join(__dirname, 'wbtenders_formatted.xlsx');
            try {
                console.log(`Saving XLSX to: ${xlsxPath}...`);
                const XLSX = require('xlsx');
                const worksheet = XLSX.utils.json_to_sheet(scrapedData, { header: HEADERS });
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, 'Tenders');
                XLSX.writeFile(workbook, xlsxPath);
                console.log('SUCCESS! XLSX saved.');
            } catch (err) {
                console.error('Error saving XLSX:', err.message);
            }
        } else {
            console.log('No data scraped.');
        }

    } catch (err) {
        console.error('Fatal error:', err.message);
    } finally {
        await browser.close();
    }
})();
