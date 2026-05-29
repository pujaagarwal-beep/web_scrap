const fs = require('fs');
const path = require('path');
const XLSX = require('./node_modules/xlsx');

try {
    const filePath = path.join(__dirname, 'KEYWORD  MASTER.xlsx');
    const workbook = XLSX.readFile(filePath);
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    // Find headers (Row 2, index 1)
    const headersRow = data[1] || [];
    
    const keywordsByCol = {};
    const allUniqueKeywords = new Set();
    
    headersRow.forEach((header, colIdx) => {
        if (!header) return;
        const key = header.toString().trim();
        keywordsByCol[key] = [];
        for (let rowIdx = 2; rowIdx < data.length; rowIdx++) {
            const val = data[rowIdx][colIdx];
            if (val !== undefined && val !== null && val.toString().trim() !== '') {
                const kw = val.toString().trim();
                keywordsByCol[key].push(kw);
                allUniqueKeywords.add(kw);
            }
        }
    });
    
    const outputData = {
        columns: keywordsByCol,
        uniqueKeywords: Array.from(allUniqueKeywords)
    };
    
    const outputPath = path.join(__dirname, 'keywords.json');
    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 4));
    console.log(`Extracted ${allUniqueKeywords.size} unique keywords across ${Object.keys(keywordsByCol).length} categories.`);
    console.log(`Saved keywords to ${outputPath}`);
} catch (err) {
    console.error('Error extracting keywords:', err.message);
}
