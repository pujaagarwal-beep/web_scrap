const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const SEARCH_KEYWORD = 'cable';

const userDataDir = path.join(__dirname, 'chrome_user_data');

(async () => {
    console.log('Starting DEBUG browser...');
    const browser = await puppeteer.launch({ 
        headless: false,
        userDataDir: userDataDir,
        defaultViewport: { width: 1366, height: 768 }
    });
    
    const page = await browser.newPage();

    try {
        const portalUrl = 'https://wbtenders.gov.in';
        await page.goto(`${portalUrl}/nicgep/app`, { waitUntil: 'networkidle2' });

        await page.waitForSelector('#SearchDescription');
        await page.type('#SearchDescription', SEARCH_KEYWORD);

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click('#Go')
        ]);

        await page.waitForFunction(() => {
            const cells = Array.from(document.querySelectorAll('td, th'));
            return cells.some(cell => cell.innerText.includes('Title and Ref.No./Tender ID'));
        }, { timeout: 15000 });

        // Test each tender ID that is failing
        const failingTenderIndices = [0, 2, 4]; // Tenders 1, 3, 5 (0-indexed) = WBSED ones

        for (const tenderIndex of failingTenderIndices) {
            console.log(`\n\n===== DEBUGGING Tender index ${tenderIndex + 1} =====`);

            const listInfo = await page.evaluate((index) => {
                const tables = Array.from(document.querySelectorAll('table'));
                const tenderTable = tables.find(t => t.innerText.includes('Title and Ref.No./Tender ID'));
                if (!tenderTable) return null;

                const rows = Array.from(tenderTable.querySelectorAll('tr'));
                const dataRows = rows.filter(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 6) return false;
                    const sNoText = cells[0].innerText.trim();
                    return /^\d+\.$|^\d+$/.test(sNoText);
                });

                if (index < dataRows.length) {
                    const row = dataRows[index];
                    const aTag = row.querySelector('a[id^="DirectLink_"]');
                    if (aTag) {
                        return {
                            linkId: aTag.id,
                            titleText: row.querySelectorAll('td')[4].innerText.trim().substring(0, 80)
                        };
                    }
                }
                return null;
            }, tenderIndex);

            if (!listInfo) {
                console.log(`Could not find tender ${tenderIndex + 1}`);
                continue;
            }

            console.log(`Clicking tender: ${listInfo.linkId} — ${listInfo.titleText}`);
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2' }),
                page.click(`#${listInfo.linkId}`)
            ]);

            // Dump ALL anchor tags on this detail page
            const allLinks = await page.evaluate(() => {
                const anchors = Array.from(document.querySelectorAll('a'));
                return anchors.map(a => ({
                    id: a.id,
                    text: (a.innerText || '').trim().replace(/\s+/g, ' ').substring(0, 100),
                    href: a.href || '',
                    onclick: a.getAttribute('onclick') || '',
                    className: a.className || ''
                }));
            });

            console.log(`\nAll <a> tags on page (${allLinks.length} total):`);
            allLinks.forEach((link, idx) => {
                if (link.text || link.id || link.href) {
                    console.log(`  [${idx}] id="${link.id}" text="${link.text}" href="${link.href.substring(0, 80)}" onclick="${link.onclick.substring(0, 80)}" class="${link.className}"`);
                }
            });

            // Also look specifically for anything that could be a doc/download link
            console.log('\n--- Potential document links (text or href contains doc/download/pdf/zip): ---');
            allLinks.forEach((link, idx) => {
                const combined = (link.text + link.href + link.onclick + link.id).toLowerCase();
                if (combined.includes('doc') || combined.includes('download') || combined.includes('pdf') || combined.includes('zip') || combined.includes('nit')) {
                    console.log(`  [${idx}] id="${link.id}" text="${link.text}" href="${link.href.substring(0, 80)}" onclick="${link.onclick.substring(0, 80)}"`);
                }
            });

            // Navigate back
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2' }),
                page.evaluate(() => {
                    const links = document.querySelectorAll('a');
                    for (let a of links) {
                        if (a.innerText.trim() === 'Back') { a.click(); return; }
                    }
                })
            ]);

            await page.waitForFunction(() => {
                const cells = Array.from(document.querySelectorAll('td, th'));
                return cells.some(cell => cell.innerText.includes('Title and Ref.No./Tender ID'));
            });
        }

        console.log('\n\nDEBUG COMPLETE. Check above for the link structure differences.');

    } catch (error) {
        console.error('Debug error:', error);
    } finally {
        await browser.close();
    }
})();
