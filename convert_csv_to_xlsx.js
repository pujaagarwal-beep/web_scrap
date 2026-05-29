const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const csvPath = path.join(__dirname, 'wbtenders_formatted.csv');
const xlsxPath = path.join(__dirname, 'wbtenders_formatted.xlsx');

if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found at: ${csvPath}`);
    process.exit(1);
}

try {
    console.log(`Reading CSV from: ${csvPath}...`);
    // Read the CSV file. SheetJS auto-detects CSV based on file extension/content.
    const workbook = XLSX.readFile(csvPath, { codepage: 65001 }); // UTF-8

    console.log(`Saving XLSX to: ${xlsxPath}...`);
    XLSX.writeFile(workbook, xlsxPath);

    console.log('SUCCESS! File successfully converted to Excel format.');
} catch (err) {
    console.error('Error during conversion:', err.message);
}
