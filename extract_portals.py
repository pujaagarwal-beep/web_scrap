import pypdf
import json
import re

pdf_path = r"c:\Users\muska_ak5dqij\OneDrive\Desktop\web scrap\AI development1.pdf"
reader = pypdf.PdfReader(pdf_path)

portals = []

# Regex to find links ending in .gov.in or similar
url_regex = re.compile(r'https?://[a-zA-Z0-9./_\-]+')

for page in reader.pages:
    text = page.extract_text()
    for line in text.split('\n'):
        # Check if the line is marked as "Done" or has a portal
        matches = url_regex.findall(line)
        for url in matches:
            # Clean up trailing spaces or chars
            url = url.strip()
            # Normalize to portal url
            if 'tenders' in url or 'eproc' in url or 'nic.in' in url or 'gem.gov.in' in url:
                # Remove trailing paths for portals if any
                # Let's keep it as is or normalize
                portals.append(url)

# Remove duplicates while preserving order
seen = set()
unique_portals = []
for p in portals:
    # Normalize to base URL or clean
    p_clean = p.split('/nicgep')[0].split('/epublish')[0].split('/eprocure')[0].rstrip('/')
    if p_clean not in seen:
        seen.add(p_clean)
        unique_portals.append(p)

output_path = r"c:\Users\muska_ak5dqij\OneDrive\Desktop\web scrap\portals.json"
with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(unique_portals, f, indent=4)

print(f"Extracted {len(unique_portals)} unique portals to {output_path}")
print("Portals sample:", unique_portals[:5])
