# GePNIC Tenders Web Scraper

An automated web scraper designed to extract tender information and statuses from GePNIC (Government e-Procurement System of National Informatics Centre) portals. This tool uses Puppeteer for browser automation and Tesseract.js for automatic CAPTCHA solving, enabling unattended scraping of tender data and stage summary PDFs.

## Features

- **Multi-Portal Support**: Scrape multiple GePNIC portals sequentially based on configuration.
- **Automated CAPTCHA Solving**: Uses image preprocessing (grayscale, binarization, morphological erosion/dilation) and Tesseract OCR to automatically solve captchas required to download stage summary PDFs.
- **Keyword & Status Search**: Searches for tenders matching configured keywords across various status categories (e.g., AOC, Technical Bid Opening, Financial Bid Opening, Retender, Cancelled).
- **PDF Downloading**: Automatically downloads the "Stage Summary" PDF for each tender.
- **Checkpoint & Auto-Resume**: Saves progress periodically. If the scraper crashes or is interrupted, it will automatically resume from the last completed portal, status, and keyword.
- **Dashboard**: Includes an HTML/CSS dashboard (`dashboard.html`) to visualize the scraped data.
- **Multiple Output Formats**: Saves scraped data in JSON, CSV, and Excel (`.xlsx`) formats.

## Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher recommended)
- Google Chrome installed (Puppeteer uses the local installation for persistence)

## Installation

1. Clone or download this repository.
2. Open a terminal in the project directory.
3. Install the required Node.js dependencies:
   ```bash
   npm install
   ```

## Configuration

Before running the scraper, you can configure the target portals and search keywords using the JSON files in the root directory.

### 1. `portals.json`
Provide an array of GePNIC portal URLs you want to scrape.
```json
[
  "https://manipurtenders.gov.in",
  "https://wbtenders.gov.in"
]
```

### 2. `keywords.json`
Provide the keywords to search for. The GePNIC portal requires keywords to be at least 4 characters long.
```json
{
  "uniqueKeywords": [
    "CABLE",
    "SUB-STATION",
    "CONDUCTOR",
    "TRANSFORMER"
  ]
}
```
*Note: If `uniqueKeywords` is missing, the scraper will attempt to extract keywords from a `columns` object or default to built-in keywords.*

## Usage

Start the scraper by running:

```bash
npm run dev
```

*(Alternatively, you can run `node scrape_portal.js`)*

### What happens during execution:
1. The script launches a visible Chromium browser (non-headless) to bypass bot protections.
2. It navigates to each configured portal's "Tenders Status" page.
3. It iterates through the configured statuses and keywords.
4. **Manual CAPTCHA Intervention:** During the initial search page, the scraper will pause and wait for you to **manually solve the captcha** and click the Search button.
5. Once results are found, it automatically pages through the results, extracts the table data, and navigates into each tender's detail page.
6. **Automatic CAPTCHA Solving:** When attempting to download the "Stage Summary" PDF from the detail page, the `captcha_solver.js` script will kick in, process the image, and automatically solve the captcha using Tesseract OCR.
7. Data is saved continuously as the scraper runs.

## Output Files

As the scraper runs, it generates and updates the following output files in the project root:

- **`scraped_tenders.json`**: Raw search result rows in JSON format.
- **`scraped_tenders.csv`**: Raw search result rows in CSV format.
- **`tender_details.json`**: Detailed information about each tender, including organization chain, stage histories, and downloaded PDF paths.
- **`dashboard_results.xlsx`**: An Excel spreadsheet aggregating the final scraped data.
- **`downloads/` (Directory)**: Contains the downloaded stage summary PDFs, organized into subfolders by portal hostname and Tender ID.
- **`scraper_checkpoint.json`**: Temporary file used to track scraping progress for auto-resume.

## Viewing the Dashboard

To view a summary of the scraped data:
1. Open the `dashboard.html` file in your web browser.
2. Note: Ensure that the output files (`tender_details.json` or `scraped_tenders.json`) exist in the directory for the dashboard to populate data correctly.

## Troubleshooting & Debugging

- **Session Expired Errors**: GePNIC portals enforce strict session timeouts. The script attempts to handle these gracefully, but if you encounter persistent session issues, restart the script. The checkpoint system will prevent duplicate work.
- **CAPTCHA Solving Fails**: If the automatic CAPTCHA solver struggles, you can adjust the image processing threshold in `captcha_solver.js` (default is 125). A copy of the processed captcha is saved as `last_cleaned_captcha.png` for debugging.
- **"No Tenders Found"**: Ensure your keywords are spelled correctly and are at least 4 characters long as per GePNIC rules.
