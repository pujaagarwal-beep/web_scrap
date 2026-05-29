/**
 * parse_pdf_data.js
 * Walks all downloads sub-folders, reads every PDF with pdf-parse,
 * extracts key tender fields and writes pdf_extracted_data.json
 */

const fs   = require('fs');
const path = require('path');

let pdfParse;
try {
  pdfParse = require('pdf-parse');
} catch (e) {
  console.error('pdf-parse not found. Run: npm install pdf-parse');
  process.exit(1);
}

// ── helpers ───────────────────────────────────────────────────────────────

function first(text, ...patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return (m[1] || m[0]).trim();
  }
  return '';
}

function allMatches(text, re) {
  const rows = [];
  let m;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = g.exec(text)) !== null) {
    rows.push(m.slice(1).map(s => (s || '').trim()));
  }
  return rows;
}

function parsePdf(text, pdfPath) {
  // Normalise whitespace but keep newlines for pattern matching
  const t = text.replace(/\r/g, '').replace(/ {2,}/g, ' ');

  // ── Tender ID ──────────────────────────────────────────────────────────
  const tenderId = first(t,
    /Tender\s*ID\s*[:\-]?\s*([A-Z0-9_]+)/i,
    /TenderID\s*[:\-]?\s*([A-Z0-9_]+)/i,
    /(\d{4}_[A-Z]+_\d+_\d+)/
  );

  // ── Tender Ref No ──────────────────────────────────────────────────────
  const tenderRef = first(t,
    /Tender\s*Ref\s*(?:No|Number)\s*[:\-]?\s*([^\n]+)/i
  );

  // ── Tender Title ───────────────────────────────────────────────────────
  const tenderTitle = first(t,
    /Tender\s*Title\s*[:\-]?\s*([^\n]{10,})/i,
    /Work\s*Name\s*[:\-]?\s*([^\n]{10,})/i
  );

  // ── Organisation ──────────────────────────────────────────────────────
  const organisation = first(t,
    /Organisation\s*Chain\s*[:\-]?\s*([^\n]+)/i,
    /Organization\s*Chain\s*[:\-]?\s*([^\n]+)/i
  );

  // ── Portal (derive from path) ──────────────────────────────────────────
  const portalMatch = pdfPath.match(/downloads[\\\/]([^\\\/]+)/);
  const portal = portalMatch ? portalMatch[1] : '';

  // ── Date ──────────────────────────────────────────────────────────────
  const reportDate = first(t,
    /Date\s*[:\-]?\s*(\d{2}-[A-Za-z]+-\d{4}[^\n]*)/i
  );

  // ── Financial Evaluation Bid List ─────────────────────────────────────
  // Typical pattern: serial · bid-number · bidder name · value · rank (L1/L2…)
  const finBids = [];

  // Pattern 1: lines with or without spaces
  const finSection = t.match(/Financial\s*Evaluation[\s\S]{0,200}?Bid\s*List([\s\S]{0,3000}?)(?:Finance\s*Evaluation\s*Summary|Awarded\s*Bid|AOC\b|$)/i);
  if (finSection) {
    const rows = allMatches(finSection[1],
      /(?:^|\n)\s*(\d{1,2})\s*(\d{6,15})\s*([A-Z0-9 &.\-\/,()\n\r]+?)\s*([\d,]+(?:\.\d+)?)[ \t]*(L-?\d*|H-?\d*|\d+)/ig
    );
    rows.forEach(r => {
      let rnk = r[4].toUpperCase().replace('-', '');
      if (/^\d+$/.test(rnk)) rnk = 'L' + parseInt(rnk, 10);
      else if (rnk === 'L01') rnk = 'L1';
      else if (rnk === 'L02') rnk = 'L2';
      else if (rnk === 'L03') rnk = 'L3';
      finBids.push({
        sno: r[0], bidNumber: r[1], bidderName: r[2].replace(/[\n\r]+/g, ' ').trim(),
        value: parseFloat(r[3].replace(/,/g, '')), rank: rnk
      });
    });
  }

  // Pattern 2: fallback – scan whole doc for L1/L2 bid lines
  if (finBids.length === 0) {
    const rows = allMatches(t,
      /(?:^|\n)\s*(\d{1,2})\s*(\d{6,15})\s*([A-Z0-9 &.\-\/,()\n\r]+?)\s*([\d,]+(?:\.\d+)?)[ \t]*(L-?\d*|H-?\d*|\d+)/ig
    );
    rows.forEach(r => {
      let rnk = r[4].toUpperCase().replace('-', '');
      if (/^\d+$/.test(rnk)) rnk = 'L' + parseInt(rnk, 10);
      else if (rnk === 'L01') rnk = 'L1';
      else if (rnk === 'L02') rnk = 'L2';
      else if (rnk === 'L03') rnk = 'L3';
      finBids.push({
        sno: r[0], bidNumber: r[1], bidderName: r[2].replace(/[\n\r]+/g, ' ').trim(),
        value: parseFloat(r[3].replace(/,/g, '')), rank: rnk
      });
    });
  }

  // ── Awarded Bids ──────────────────────────────────────────────────────
  const awardedBids = [];
  const awardSection = t.match(/Awarded\s*Bids?\s*List([\s\S]{0,2000}?)(?:Bid\s*Opening|Technical\s*Eval|Finance\s*Eval|$)/i);
  if (awardSection) {
    const rows = allMatches(awardSection[1],
      /(?:^|\n)\s*(\d{1,2})\s*(\d{6,15})\s*([A-Z0-9 &.\-\/,()\n\r]+?)\s*(?:INR|USD|EUR)?\s*([\d,]+\.?\d*)/ig
    );
    rows.forEach(r => awardedBids.push({ 
      sno: r[0], 
      bidNumber: r[1], 
      bidderName: r[2].replace(/[\n\r]+/g, ' ').trim(),
      value: parseFloat(r[3].replace(/,/g, '')) 
    }));
  }

  // ── Contract / AOC ────────────────────────────────────────────────────
  const contractValue = first(t,
    /Total\s*Contract\s*Value\s*[:\-]?\s*(?:INR)?\s*([\d,]+\.?\d*)/i,
    /Awarded\s*Value\s*[:\-]?\s*(?:INR)?\s*([\d,]+\.?\d*)/i
  );
  const contractDate = first(t,
    /Contract\s*Date\s*[:\-]?\s*(\d{2}-[A-Za-z]+-\d{4})/i,
    /AOC\s*Date\s*[:\-]?\s*(\d{2}-[A-Za-z]+-\d{4})/i
  );
  const workDays = first(t,
    /Work\s*Completion\s*Period[^:\n]*[:\-]?\s*(\d+)/i,
    /Completion\s*Period[^:\n]*[:\-]?\s*(\d+)/i
  );
  const updatedBy = first(t,
    /Updated\s*By\s*[:\-]?\s*([A-Z][a-zA-Z ]{2,40})/i
  );
  const awardedCurrency = first(t, /Awarded\s*Currency\s*[:\-]?\s*(INR|USD|EUR)/i) || 'INR';

  // ── L1 winner name ─────────────────────────────────────────────────────
  const l1 = finBids.find(b => b.rank === 'L1' || b.rank === 'H1');
  let l1Winner = l1 ? l1.bidderName : '';
  let l1Value = l1 ? l1.value : null;

  if (!l1Winner && awardedBids.length > 0) {
    l1Winner = awardedBids[0].bidderName;
    const matchedBid = finBids.find(b => b.bidNumber === awardedBids[0].bidNumber);
    l1Value = matchedBid ? matchedBid.value : (awardedBids[0].value || null);
  }

  return {
    tenderId,
    tenderRef,
    tenderTitle: tenderTitle.slice(0, 300),
    organisation: organisation.slice(0, 200),
    portal,
    reportDate,
    financialBids: finBids,
    awardedBids,
    contractValue: contractValue ? parseFloat(contractValue.replace(/,/g, '')) : null,
    awardedCurrency,
    contractDate,
    workCompletionDays: workDays ? parseInt(workDays) : null,
    updatedBy,
    l1Winner,
    l1Value,
    totalBids: Math.max(finBids.length, awardedBids.length),
    pdfFile: path.basename(pdfPath)
  };
}

// ── Walk directories ──────────────────────────────────────────────────────

function walkPdfs(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkPdfs(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      results.push(full);
    }
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const downloadsDir = path.join(__dirname, 'downloads');
  const outFile      = path.join(__dirname, 'pdf_extracted_data.json');

  const pdfs = walkPdfs(downloadsDir);
  console.log(`Found ${pdfs.length} PDFs. Parsing…`);

  const results = [];
  let ok = 0, fail = 0;

  for (let i = 0; i < pdfs.length; i++) {
    const pdfPath = pdfs[i];
    process.stdout.write(`\r[${i+1}/${pdfs.length}] ${path.basename(pdfPath)}`.padEnd(80));
    try {
      const buf  = fs.readFileSync(pdfPath);
      const data = await pdfParse(buf, { max: 10 }); // limit to first 10 pages
      const rec  = parsePdf(data.text, pdfPath);
      rec.pdfPath = pdfPath.replace(__dirname + path.sep, '');
      results.push(rec);
      ok++;
    } catch (e) {
      fail++;
      results.push({
        tenderId: '', portal: '', pdfFile: path.basename(pdfPath),
        pdfPath: pdfPath.replace(__dirname + path.sep, ''),
        error: e.message, financialBids: [], awardedBids: []
      });
    }
  }

  console.log(`\n\nDone. OK: ${ok}  Errors: ${fail}`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf8');
  console.log(`Saved → ${outFile}`);
}

main().catch(console.error);
