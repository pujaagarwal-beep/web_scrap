const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const XLSX = require('./node_modules/xlsx');
const { solveCaptcha } = require('./captcha_solver');

// -----------------------------------------------------------------------
// CONFIGURATION & SETUP
// -----------------------------------------------------------------------
const OUTPUT_JSON_PATH     = path.join(__dirname, 'scraped_tenders.json');
const OUTPUT_CSV_PATH      = path.join(__dirname, 'scraped_tenders.csv');
const OUTPUT_DETAILS_PATH  = path.join(__dirname, 'tender_details.json');
const OUTPUT_EXCEL_PATH    = path.join(__dirname, 'dashboard_results.xlsx');
const CHECKPOINT_PATH      = path.join(__dirname, 'scraper_checkpoint.json');  // AUTO-RESUME

// Load configurations
let targetPortals = [];
let keywordsList = [];

try {
    if (fs.existsSync(path.join(__dirname, 'portals.json'))) {
        targetPortals = JSON.parse(fs.readFileSync(path.join(__dirname, 'portals.json'), 'utf8'));
    } else {
        targetPortals = ['https://manipurtenders.gov.in', 'https://wbtenders.gov.in'];
    }

    if (fs.existsSync(path.join(__dirname, 'keywords.json'))) {
        const kwData = JSON.parse(fs.readFileSync(path.join(__dirname, 'keywords.json'), 'utf8'));
        // Extract from uniqueKeywords if it exists, otherwise extract and flatten all arrays from the 'columns' object
        const allKeywords = kwData.uniqueKeywords || (kwData.columns ? Object.values(kwData.columns).flat() : ['CABLE', 'SUB-STATION', 'CONDUCTOR']);
        // Remove duplicates and filter short keywords
        const uniqueKws = [...new Set(allKeywords)];
        // GePNIC requires minimum 4 characters — filter out short keywords
        keywordsList = uniqueKws.filter(kw => kw && kw.trim().length >= 4);
        console.log(`Loaded ${uniqueKws.length} unique keywords from config, ${keywordsList.length} valid (≥4 chars).`);
    } else {
        keywordsList = ['CABLE', 'SUB-STATION', 'CONDUCTOR'];
    }
} catch (e) {
    console.error('Error loading config files:', e.message);
    targetPortals = ['https://manipurtenders.gov.in', 'https://wbtenders.gov.in'];
    keywordsList = ['CABLE', 'SUB-STATION', 'CONDUCTOR'];
}

// RUN ALL portals from AI development1.pdf and ALL keywords from KEYWORD MASTER
const PORTALS_TO_RUN  = targetPortals;  // ALL portals
const KEYWORDS_TO_RUN = keywordsList;   // ALL keywords from KEYWORD MASTER
const STATUS_OPTIONS = [
    { value: '6', text: 'AOC' },
    { value: '2', text: 'Technical Bid Opening' },
    { value: '4', text: 'Financial Bid Opening' },
    { value: '7', text: 'Retender' },
    { value: '8', text: 'Cancelled' }
];

// Ensure downloads directory exists
const downloadsBaseDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsBaseDir)) {
    fs.mkdirSync(downloadsBaseDir, { recursive: true });
}

// Global Results Store
let scrapedResults = [];
if (fs.existsSync(OUTPUT_JSON_PATH)) {
    try { scrapedResults = JSON.parse(fs.readFileSync(OUTPUT_JSON_PATH, 'utf8')); } catch (e) {}
}

// Global Tender Details Store
let tenderDetailsStore = {};
if (fs.existsSync(OUTPUT_DETAILS_PATH)) {
    try { tenderDetailsStore = JSON.parse(fs.readFileSync(OUTPUT_DETAILS_PATH, 'utf8')); } catch (e) {}
}

// Load checkpoint for auto-resume
let checkpoint = { portalIndex: 0, statusIndex: 0, keywordIndex: 0 };
if (fs.existsSync(CHECKPOINT_PATH)) {
    try {
        checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
        console.log(`[RESUME] Resuming from checkpoint: Portal[${checkpoint.portalIndex}] Status[${checkpoint.statusIndex}] Keyword[${checkpoint.keywordIndex}]`);
    } catch (e) {}
}

function saveCheckpoint(pi, si, ki) {
    try { fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify({ portalIndex: pi, statusIndex: si, keywordIndex: ki })); } catch(e) {}
}

// Chrome profile for persistence
const userDataDir = path.join(__dirname, 'chrome_user_data');

// -----------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------
/**
 * Safely type text into an input box by completely clearing it first
 */
async function safelyTypeInput(page, selector, text) {
    try {
        await page.waitForSelector(selector, { timeout: 5000 });
        await page.focus(selector);
        
        // Silently empty the text box (no blue highlight flicker)
        await page.$eval(selector, el => {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        
        // Emulate a single backspace to ensure any lingering JS state recognizes it is empty
        await page.keyboard.press('Backspace');
        
        // Natively type the new keyword
        await page.type(selector, text, { delay: 10 });
    } catch (e) {
        console.warn(`  [Helper] Failed to safely type into ${selector}:`, e.message);
    }
}

async function handleDownloadCaptcha(page, downloadFolder) {
    // Set download path
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadFolder
    });

    const beforeFiles = new Set(fs.readdirSync(downloadFolder));
    let attempts = 0;

    while (attempts < 5) {
        console.log(`    [Download] Attempting download captcha solve (Attempt ${attempts + 1})...`);
        const text = await solveCaptcha(page);
        if (!text || text.length !== 6) {
            console.warn(`    [Captcha] OCR returned invalid length: ${text ? text.length : 0} ("${text}"). Expected 6. Refreshing...`);
            // Refresh captcha
            const refreshBtn = await page.$('#captcha');
            if (refreshBtn) await refreshBtn.click();
            await new Promise(r => setTimeout(r, 1500));
            attempts++;
            continue;
        }

        await page.evaluate(() => {
            const inp = document.querySelector('#captchaText');
            if (inp) inp.value = '';
        });
        await page.type('#captchaText', text);

        // Click download/submit button
        const submitBtn = await page.$('input[type="submit"], #Submit, #Search');
        if (submitBtn) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
                submitBtn.click()
            ]);
        }

        // Check if download succeeded or captcha failed
        const onCaptchaPage = await page.evaluate(() => {
            return !!document.querySelector('#captchaText');
        }).catch(() => false);

        if (!onCaptchaPage) {
            // Captcha solved! Wait for download to complete
            console.log('    [Download] Captcha accepted. Waiting for download...');
            const pollStart = Date.now();
            while (Date.now() - pollStart < 30000) {
                const currentFiles = fs.readdirSync(downloadFolder);
                const newFiles = currentFiles.filter(f => !beforeFiles.has(f));
                if (newFiles.length > 0) {
                    const isDownloading = newFiles.some(f => f.endsWith('.crdownload') || f.endsWith('.tmp'));
                    if (!isDownloading) {
                        const finishedFile = newFiles.find(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
                        if (finishedFile) {
                            return finishedFile;
                        }
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            break;
        } else {
            console.warn('    [Download] Captcha failed/rejected. Refreshing...');
            const refreshBtn = await page.$('#captcha');
            if (refreshBtn) await refreshBtn.click();
            await new Promise(r => setTimeout(r, 1500));
            attempts++;
        }
    }
    return null;
}

function updateDashboardExcel(store) {
    try {
        const data = Object.values(store).map(t => ({
            'Website (Portal)': t.Portal,
            'Keyword': t.Keyword,
            'Tender Status': t.StatusCategory,
            'Tender ID': t.TenderID,
            'Title': t.Title,
            'Scraped PDF': Array.isArray(t.DownloadedPDFs) ? t.DownloadedPDFs.join(' | ') : (t.DownloadedPDFs || '')
        }));
        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Scraping Results');
        XLSX.writeFile(wb, OUTPUT_EXCEL_PATH);
    } catch (e) {
        console.warn(`  [Helper] Failed to update Excel sheet: ${e.message}`);
    }
}

function saveResultsToFiles() {
    // Save to JSON
    fs.writeFileSync(OUTPUT_JSON_PATH, JSON.stringify(scrapedResults, null, 4));
    console.log(`Saved results to ${OUTPUT_JSON_PATH}`);

    // Save to CSV
    if (scrapedResults.length > 0) {
        const headers = [
            'Portal', 'Keyword', 'StatusCategory', 'SNo', 'TenderID', 
            'TitleAndRefNo', 'OrganisationChain', 'TenderStage', 
            'CleanTitle', 'RefNo', 'DownloadedPDFs'
        ];
        const csvLines = [headers.map(h => `"${h}"`).join(',')];
        scrapedResults.forEach(row => {
            csvLines.push(
                headers.map(h => `"${(row[h] || '').toString().replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`).join(',')
            );
        });
        fs.writeFileSync(OUTPUT_CSV_PATH, csvLines.join('\n'));
        console.log(`Saved results to ${OUTPUT_CSV_PATH}`);
    }
}

// -----------------------------------------------------------------------
// MAIN SCRAPER
// -----------------------------------------------------------------------
(async () => {
    console.log('Launching browser for GePNIC multi-portal status scraping...');
    const browser = await puppeteer.launch({
        headless: false,
        userDataDir,
        defaultViewport: { width: 1366, height: 768 },
        args: ['--disable-web-security', '--no-sandbox'],
        protocolTimeout: 300000
    });

    let page = await browser.newPage();
    page.setDefaultNavigationTimeout(120000);  // 2 min for slow govt portals
    page.setDefaultTimeout(120000);

    // Helper: get a fresh page if the current one has crashed/detached
    async function getPage() {
        try {
            // Quick check — if the page is detached, isClosed() returns true
            if (page.isClosed()) throw new Error('Page is closed');
            await page.evaluate(() => true);  // lightweight ping
            return page;
        } catch (e) {
            console.warn('  [Recovery] Page detached/crashed. Creating a fresh page...');
            try { await page.close().catch(() => {}); } catch(_) {}
            page = await browser.newPage();
            page.setDefaultNavigationTimeout(120000);
            page.setDefaultTimeout(120000);
            return page;
        }
    }

    try {
        for (let portalIdx = checkpoint.portalIndex; portalIdx < PORTALS_TO_RUN.length; portalIdx++) {
            const portal = PORTALS_TO_RUN[portalIdx];
            console.log(`\n======================================================`);
            console.log(`Targeting Portal: ${portal}`);
            console.log(`======================================================`);

            const portalHost = new URL(portal).hostname;
            const portalFolder = path.join(downloadsBaseDir, portalHost);
            if (!fs.existsSync(portalFolder)) fs.mkdirSync(portalFolder, { recursive: true });

            // 1. Navigate to portal (retry up to 3 times on timeout)
            let portalLoaded = false;
            for (let navRetry = 0; navRetry < 3; navRetry++) {
                try {
                    page = await getPage();  // recover page if it crashed
                    await page.goto(`${portal}/nicgep/app`, { waitUntil: 'domcontentloaded', timeout: 90000 });
                    portalLoaded = true;
                    break;
                } catch (navErr) {
                    console.warn(`  [Nav] Attempt ${navRetry + 1} failed: ${navErr.message}. Retrying...`);
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
            if (!portalLoaded) {
                console.error(`  [Nav] Could not reach portal ${portal} after 3 attempts. Skipping.`);
                continue;
            }

            // 2. Click "Tenders Status" link
            console.log('Searching for Tenders Status page...');
            const statusLinkId = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                const match = links.find(l => l.innerText && l.innerText.trim() === 'Tenders Status');
                if (match) {
                    if (!match.id) match.id = 'temp_tenders_status_link';
                    return match.id;
                }
                return null;
            });

            if (!statusLinkId) {
                console.error(`[-] "Tenders Status" link not found on ${portal}. Skipping portal.`);
                continue;
            }

            console.log('Clicking Tenders Status link...');
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2' }),
                page.click(`#${statusLinkId}`)
            ]);

            const statusPageUrl = page.url();

            // 3. Search Loop (Statuses x Keywords)
            const startSi = (portalIdx === checkpoint.portalIndex) ? checkpoint.statusIndex : 0;
            for (let si = startSi; si < STATUS_OPTIONS.length; si++) {
                const statusOpt = STATUS_OPTIONS[si];
                const startKi = (portalIdx === checkpoint.portalIndex && si === checkpoint.statusIndex) ? checkpoint.keywordIndex : 0;
                for (let ki = startKi; ki < KEYWORDS_TO_RUN.length; ki++) {
                    const keyword = KEYWORDS_TO_RUN[ki];
                    saveCheckpoint(portalIdx, si, ki);  // Save position before each search
                    console.log(`\n[*] Searching Status: "${statusOpt.text}" | Keyword: "${keyword}"`);
                    try {

                    // Reset form cleanly using "Clear" button (no page reload = no flickering)
                    // We put this in a separate evaluate block with a try-catch because some portals (e.g., Manipur) 
                    // have broken Javascript on their Clear button which throws DatePicker errors.
                    await page.evaluate(() => {
                        try {
                            const inputs = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button'));
                            const clearBtn = inputs.find(el => (el.value || el.innerText || '').trim().toLowerCase() === 'clear');
                            if (clearBtn) clearBtn.click();
                        } catch (e) {}
                    }).catch(() => {});

                    await new Promise(r => setTimeout(r, 600));

                    // Manually clear old results from DOM in a fresh evaluate block so previous errors don't stop this
                    await page.evaluate(() => {
                        const tables = Array.from(document.querySelectorAll('table'));
                        const resTable = tables.find(t => t.innerText.includes('Tender ID') && t.innerText.includes('Title and Ref.No.'));
                        if (resTable) resTable.remove();

                        // Manually remove old 'No Tenders found' text so we don't falsely skip
                        const allElements = document.querySelectorAll('*');
                        for (let i = 0; i < allElements.length; i++) {
                            const el = allElements[i];
                            if (el.children.length === 0 && el.innerText) {
                                const text = el.innerText.toLowerCase();
                                if (text.includes('no tenders found') || text.includes('no tender found') || text.includes('no records found') || text.includes('no record found') || text.includes('data not found') || text.includes('no data found')) {
                                    el.innerText = '';
                                }
                            }
                        }
                    });
                    await new Promise(r => setTimeout(r, 600));

                    // Select dropdown status
                    const hasStatusOption = await page.evaluate((val) => {
                        const sel = document.querySelector('#tenderStatus');
                        if (!sel) return false;
                        return Array.from(sel.options).some(o => o.value === val);
                    }, statusOpt.value);

                    if (!hasStatusOption) {
                        console.warn(`[-] Status option "${statusOpt.text}" not found on this portal. Skipping.`);
                        continue;
                    }

                    await page.select('#tenderStatus', statusOpt.value);

                    // Type keyword safely (completely clearing input first)
                    await safelyTypeInput(page, '#KeyWord', keyword);

                    // ── AUTO-SOLVE CAPTCHA and click Search ──
                    console.log(`\n[AUTO-CAPTCHA] Solving captcha for Status: "${statusOpt.text}" | Keyword: "${keyword}"`);

                    let searchHasData = false;
                    let searchSuccess = false;
                    const MAX_CAPTCHA_ATTEMPTS = 5;

                    for (let captchaAttempt = 1; captchaAttempt <= MAX_CAPTCHA_ATTEMPTS; captchaAttempt++) {
                        console.log(`  [Captcha] Attempt ${captchaAttempt}/${MAX_CAPTCHA_ATTEMPTS}...`);

                        // Check if captcha input field actually exists on this page
                        const hasCaptcha = await page.evaluate(() => !!document.querySelector('#captchaText')).catch(() => false);
                        if (!hasCaptcha) {
                            // No captcha needed — try clicking Search directly
                            console.log('  [Captcha] No captcha field found. Clicking Search directly...');
                            const searchBtn = await page.$('input[type="submit"][value="Search"], #Search, input[value="Search"]');
                            if (searchBtn) {
                                await Promise.all([
                                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
                                    searchBtn.click()
                                ]);
                            }
                        } else {
                            // Solve captcha using OCR
                            const solvedText = await solveCaptcha(page);
                            if (!solvedText || solvedText.length !== 6) {
                                console.warn(`  [Captcha] OCR returned invalid length: ${solvedText ? solvedText.length : 0} ("${solvedText}"). Expected 6. Refreshing captcha and retrying...`);
                                await page.click('#captcha').catch(() => {});  // Refresh captcha button (id="captcha")
                                await new Promise(r => setTimeout(r, 2000));
                                continue;
                            }

                            // Clear captcha input box and type the solved text
                            await page.$eval('#captchaText', el => { el.value = ''; });
                            await page.focus('#captchaText');
                            await page.type('#captchaText', solvedText, { delay: 50 });
                            console.log(`  [Captcha] Filled "${solvedText}" into #captchaText. Clicking #Search...`);

                            // Click the Search submit button directly by ID
                            const searchExists = await page.$('#Search').then(el => !!el).catch(() => false);
                            if (!searchExists) {
                                console.warn('  [Captcha] #Search button not found on page. Skipping keyword.');
                                break;
                            }

                            await Promise.all([
                                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
                                page.click('#Search')
                            ]);
                            await new Promise(r => setTimeout(r, 1000));
                        }

                        // ── Check result of the search ──
                        const isEmpty = await page.evaluate(() => {
                            const text = document.body.innerText.toLowerCase();
                            return text.includes('no tenders found') ||
                                   text.includes('no tender found')  ||
                                   text.includes('no records found') ||
                                   text.includes('no record found')  ||
                                   text.includes('search results - nil') ||
                                   text.includes('no tenders are available') ||
                                   text.includes('no records available') ||
                                   text.includes('no data found') ||
                                   text.includes('no result found') ||
                                   text.includes('data not found');
                        }).catch(() => false);

                        if (isEmpty) {
                            console.log('  [Skip] No tenders found for this keyword. Moving on.');
                            searchSuccess = true;
                            searchHasData = false;
                            break;
                        }

                        const hasResults = await page.evaluate(() => {
                            const tables = Array.from(document.querySelectorAll('table'));
                            const resTable = tables.find(t => t.innerText.includes('Tender ID') && t.innerText.includes('Title and Ref.No.'));
                            if (!resTable) return false;
                            const rows = Array.from(resTable.querySelectorAll('tr'));
                            return rows.some(r => {
                                const cells = r.querySelectorAll('td');
                                return cells.length >= 6 && /^\d+\.?$/.test(cells[0].innerText.trim());
                            });
                        }).catch(() => false);

                        if (hasResults) {
                            console.log('  [OK] Results detected! Proceeding to scrape...');
                            searchSuccess = true;
                            searchHasData = true;
                            break;
                        }

                        // Check if still on captcha form (wrong answer was rejected)
                        const stillHasCaptcha = await page.evaluate(() => !!document.querySelector('#captchaText')).catch(() => false);
                        if (stillHasCaptcha) {
                            console.warn(`  [Captcha] Wrong answer or rejected. Refreshing captcha and retrying...`);
                            await page.click('#captcha').catch(() => {});  // id="captcha" = Refresh button
                            await new Promise(r => setTimeout(r, 2000));
                        } else {
                            // Page changed but no results — could be a server error
                            console.warn('  [Captcha] Unexpected page state after search. Retrying...');
                            await new Promise(r => setTimeout(r, 1500));
                        }
                    }

                    if (!searchSuccess) {
                        console.warn(`  [AUTO-CAPTCHA] Failed to solve captcha after ${MAX_CAPTCHA_ATTEMPTS} attempts. Skipping keyword.`);
                    }

                    if (!searchHasData) {
                        console.log(`  [Skip] Query has 0 results. Moving to next keyword.`);
                        continue;
                    }

                    // 4. Scrape search results table with Pagination
                    let hasNextPage = true;
                    let pageNum = 1;

                    while (hasNextPage) {
                        console.log(`  [Scrape] Analyzing results table (Page ${pageNum})...`);
                        const listRows = await page.evaluate(() => {
                            const tables = Array.from(document.querySelectorAll('table'));
                            const resTable = tables.find(t => t.innerText.includes('Tender ID') && t.innerText.includes('Title and Ref.No.'));
                            if (!resTable) return [];

                            const rows = Array.from(resTable.querySelectorAll('tr'));
                            const dataRows = rows.filter(r => {
                                const cells = r.querySelectorAll('td');
                                return cells.length >= 6 && /^\d+\.?$/.test(cells[0].innerText.trim());
                            });

                            return dataRows.map((r, idx) => {
                                const cells = r.querySelectorAll('td');
                                const aTags = r.querySelectorAll('a');
                                
                                let linkId = '';
                                const statusLink = Array.from(aTags).find(a => a.id && a.id.includes('DirectLink'));
                                if (statusLink) {
                                    linkId = statusLink.id;
                                } else if (aTags.length > 0) {
                                    const lastLink = aTags[aTags.length - 1];
                                    if (!lastLink.id) lastLink.id = `temp_status_link_${idx}`;
                                    linkId = lastLink.id;
                                }

                                return {
                                    index: idx,
                                    sNo: cells[0].innerText.trim().replace('.', ''),
                                    tenderId: cells[1].innerText.trim(),
                                    titleAndRef: cells[2].innerText.trim(),
                                    orgChain: cells[3].innerText.trim(),
                                    stage: cells[4].innerText.trim(),
                                    linkId: linkId
                                };
                            });
                        });

                        console.log(`  [Scrape] Found ${listRows.length} tenders on Page ${pageNum}.`);
                        if (listRows.length === 0) {
                            hasNextPage = false;
                            break;
                        }

                        // 5. Iterate through results and download PDFs
                        for (let i = 0; i < listRows.length; i++) {
                            const item = listRows[i];
                            console.log(`  --> Processing Tender [${i + 1}/${listRows.length}] ID: ${item.tenderId}`);

                            // Prevent duplicate scrapes if already complete
                            if (scrapedResults.some(r => r.TenderID === item.tenderId && r.StatusCategory === statusOpt.text && r.DownloadedPDFs)) {
                                console.log(`      Tender already scraped under this category. Skipping.`);
                                continue;
                            }

                            // Parse Title and RefNo
                            let cleanTitle = item.titleAndRef;
                            let refNo = '';
                            const titleMatch = item.titleAndRef.match(/\[(.*?)\]/g);
                            if (titleMatch && titleMatch.length >= 2) {
                                cleanTitle = titleMatch[0].replace(/\[|\]/g, '').trim();
                                refNo = titleMatch[1].replace(/\[|\]/g, '').trim();
                            }

                            const tenderFolder = path.join(portalFolder, item.tenderId);
                            if (!fs.existsSync(tenderFolder)) fs.mkdirSync(tenderFolder, { recursive: true });

                            let downloadedPdfs = [];

                            // Click the Status Details link
                            if (item.linkId) {
                                try {
                                    console.log(`      Navigating to Status Details...`);

                                    await Promise.all([
                                        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
                                        page.click(`#${item.linkId}`)
                                    ]);

                                    const detailPageUrl = page.url();

                                    // Extract all stage info
                                    const detailData = await page.evaluate(() => {
                                        const getText = (sel) => {
                                            const el = document.querySelector(sel);
                                            return el ? el.innerText.trim() : '';
                                        };

                                        // Find only the relevant stages table (exclude headers/footers)
                                        const tables = Array.from(document.querySelectorAll('table'));
                                        const stageTable = tables.find(t => {
                                            const txt = t.innerText;
                                            return txt.includes('Tender Stage') && (txt.includes('AOC') || txt.includes('Technical') || txt.includes('Financial') || txt.includes('Cancelled') || txt.includes('Retender'));
                                        });

                                        const rows = stageTable ? Array.from(stageTable.querySelectorAll('tr')) : [];
                                        const dataRows = rows.filter(r => {
                                            const cells = r.querySelectorAll('td');
                                            return cells.length >= 3 && /^\d+\.?$/.test(cells[0].innerText.trim());
                                        });

                                        const stages = dataRows.map(r => {
                                            const cells = r.querySelectorAll('td');
                                            return {
                                                sNo: cells[0].innerText.trim().replace('.', ''),
                                                stage: cells[1].innerText.trim(),
                                                status: cells[2].innerText.trim()
                                            };
                                        });

                                        // Try to find the stage summary download link/icon
                                        let stagePdfUrl = '';
                                        const anchors = Array.from(document.querySelectorAll('a'));
                                        const pdfLink = anchors.find(a => 
                                            (a.innerText || '').toLowerCase().includes('click link') || 
                                            (a.innerText || '').toLowerCase().includes('stage summary') ||
                                            (a.href || '').toLowerCase().includes('directlink_0') ||
                                            (a.href || '').toLowerCase().includes('tenderstatusdoc')
                                        );
                                        if (pdfLink) {
                                            stagePdfUrl = pdfLink.href;
                                        }

                                        return {
                                            fields: {
                                                'Organization Chain': getText('#orgChain') || getText('td:nth-child(2)'),
                                                'Tender Title': getText('#tenderTitle') || getText('h4'),
                                                'Tender Ref No': getText('#tenderRefNo')
                                            },
                                            stages: stages,
                                            stagePdfUrl: stagePdfUrl
                                        };
                                    });

                                    // Save extracted detail using composite key to prevent overwriting duplicate tenders
                                    const detailsKey = item.tenderId + '_' + statusOpt.text.replace(/\s+/g, '');
                                    tenderDetailsStore[detailsKey] = {
                                        TenderID: item.tenderId,
                                        Portal: portal,
                                        StatusCategory: statusOpt.text,
                                        Keyword: keyword,
                                        OrganizationChain: detailData.fields['Organization Chain'] || item.orgChain,
                                        TenderTitle: detailData.fields['Tender Title'] || cleanTitle,
                                        TenderRefNo: detailData.fields['Tender Ref No'] || refNo,
                                        Stages: detailData.stages,
                                        StageSummaryPdfUrl: detailData.stagePdfUrl,
                                        DetailPageUrl: detailPageUrl,
                                        ScrapedAt: new Date().toISOString()
                                    };
                                    fs.writeFileSync(OUTPUT_DETAILS_PATH, JSON.stringify(tenderDetailsStore, null, 2), 'utf8');
                                    console.log(`      ✓ Details saved to tender_details.json (${Object.keys(tenderDetailsStore).length} records total)`);

                                    // ---- STEP B: Download the stage summary PDF ----
                                    console.log(`      Clicking stage summary link (expecting new tab)...`);
                                    
                                    const newTabPromise = new Promise(resolve => {
                                        const listener = async target => {
                                            if (target.type() === 'page') {
                                                const newPage = await target.page();
                                                browser.off('targetcreated', listener);
                                                resolve(newPage);
                                            }
                                        };
                                        browser.on('targetcreated', listener);
                                        setTimeout(() => {
                                            browser.off('targetcreated', listener);
                                            resolve(null);
                                        }, 8000);
                                    });

                                    const clickedSummary = await page.evaluate(() => {
                                        const anchors = Array.from(document.querySelectorAll('a'));
                                        const el = anchors.find(a =>
                                            (a.innerText || '').toLowerCase().includes('click link') ||
                                            (a.innerText || '').toLowerCase().includes('stage summary') ||
                                            (a.href || '').toLowerCase().includes('directlink_0') ||
                                            (a.href || '').toLowerCase().includes('tenderstatusdoc')
                                        );
                                        if (el) {
                                            el.click();
                                            return { href: el.href, text: el.innerText.trim() };
                                        }
                                        return null;
                                    });

                                    if (clickedSummary) {
                                        const popupPage = await newTabPromise;
                                        if (popupPage) {
                                            console.log(`      Popup captured. Waiting for it to load...`);
                                            await popupPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
                                            await new Promise(r => setTimeout(r, 2000));
                                            
                                            const isError = await popupPage.evaluate(() => document.body.innerText.includes('Your session in the client area has expired'));
                                            
                                            if (isError) {
                                                console.warn(`      ✗ GePNIC threw a Session Expired error in the popup! Could not capture PDF.`);
                                            } else {
                                                const pdfFilename = `stage_summary_${item.tenderId}.pdf`;
                                                const pdfPath = path.join(tenderFolder, pdfFilename);
                                                try {
                                                    await popupPage.pdf({
                                                        path: pdfPath,
                                                        format: 'A4',
                                                        printBackground: true,
                                                        margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
                                                    });
                                                    const relPath = path.relative(__dirname, pdfPath);
                                                    downloadedPdfs.push(relPath);
                                                    if (tenderDetailsStore[detailsKey]) {
                                                        tenderDetailsStore[detailsKey].DownloadedPDFs = downloadedPdfs;
                                                        fs.writeFileSync(OUTPUT_DETAILS_PATH, JSON.stringify(tenderDetailsStore, null, 2), 'utf8');
                                                        updateDashboardExcel(tenderDetailsStore);
                                                    }
                                                    console.log(`      ✓ Stage summary PDF saved: ${pdfPath}`);
                                                } catch(pdfErr) {
                                                    console.warn(`      ✗ PDF save failed: ${pdfErr.message}`);
                                                }
                                            }
                                            await popupPage.close().catch(() => {});
                                        } else {
                                            console.warn(`      ✗ Popup was blocked or failed to open.`);
                                        }
                                    } else {
                                        console.log(`      No stage summary link found on this details page.`);
                                    }

                                    // Navigate back to the results list in the main tab using the page's built-in "Back" button/link
                                    console.log(`      Navigating back to results list...`);
                                    const backClicked = await page.evaluate(() => {
                                        const elements = Array.from(document.querySelectorAll('a, input, button'));
                                        const backBtn = elements.find(el => {
                                            const txt = (el.innerText || el.value || '').trim().toLowerCase();
                                            return txt === 'back' || txt.includes('back');
                                        });
                                        if (backBtn) {
                                            if (!backBtn.id) backBtn.id = 'temp_back_button_details';
                                            backBtn.click();
                                            return true;
                                        }
                                        return false;
                                    });

                                    if (backClicked) {
                                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
                                    } else {
                                        console.warn(`      [Warning] No "Back" button found on page. Falling back to page.goBack()...`);
                                        await page.goBack({ waitUntil: 'networkidle2', timeout: 15000 }).catch(async () => {
                                            await page.goto(detailPageUrl, { waitUntil: 'networkidle2' }).catch(() => {});
                                        });
                                    }

                                } catch (err) {
                                    console.error(`      Error navigating/downloading for tender ${item.tenderId}:`, err.message);
                                }
                            }

                            // Save row in scrapedResults
                            const newRow = {
                                Portal: portal,
                                Keyword: keyword,
                                StatusCategory: statusOpt.text,
                                SNo: item.sNo,
                                TenderID: item.tenderId,
                                TitleAndRefNo: item.titleAndRef,
                                OrganisationChain: item.orgChain,
                                TenderStage: item.stage,
                                CleanTitle: cleanTitle,
                                RefNo: refNo,
                                DownloadedPDFs: downloadedPdfs.join(', ')
                            };

                            // Remove older identical row if exists and push new
                            scrapedResults = scrapedResults.filter(r => !(r.TenderID === item.tenderId && r.StatusCategory === statusOpt.text));
                            scrapedResults.push(newRow);

                            saveResultsToFiles();

                            // Wait 1 second before moving to next tender
                            await new Promise(r => setTimeout(r, 1000));
                        }

                        // Check if there is a next page
                        hasNextPage = await page.evaluate(() => {
                            const links = Array.from(document.querySelectorAll('a'));
                            const nextBtn = links.find(a => a.innerText && a.innerText.includes('Next'));
                            if (nextBtn) {
                                nextBtn.id = 'temp_next_page_btn';
                                return true;
                            }
                            return false;
                        });

                        if (hasNextPage) {
                            console.log(`  [Scrape] Moving to next page of results...`);
                            await Promise.all([
                                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
                                page.click('#temp_next_page_btn')
                            ]);
                            pageNum++;
                        }
                    }
                    } catch (kwErr) {
                        console.warn(`  [SKIP] Error on keyword "${keyword}": ${kwErr.message}. Continuing...`);
                        // Try to get back to the status page so next keyword can run
                        await page.goto(statusPageUrl, { waitUntil: 'networkidle2' }).catch(() => {});
                    }
                } // end keyword loop
            } // end status loop
            // Reset keyword/status checkpoint after a portal completes
            checkpoint.statusIndex = 0;
            checkpoint.keywordIndex = 0;
        }

        // All done — delete checkpoint
        if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
        console.log('\n======================================================');
        console.log('SCRAPING COMPLETED SUCCESSFULLY!');
        console.log('======================================================\n');

    } catch (err) {
        console.error('Fatal error during scraping session:', err.message);
        console.log('[AUTO-RESTART] Restarting scraper in 5 seconds...');
        await browser.close().catch(() => {});
        await new Promise(r => setTimeout(r, 5000));
        // Respawn
        const { execFile } = require('child_process');
        execFile(process.execPath, [__filename], { detached: true, stdio: 'inherit' }).unref();
    } finally {
        try { await browser.close(); } catch(e) {}
    }
})();

