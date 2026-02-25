#!/usr/bin/env python3
"""
PDF Table Extractor for Liffy documentMiner.
Uses pdfplumber to detect and extract tables from PDFs.
Input: PDF file path (command line arg)
Output: JSON to stdout — { tables: [...], has_tables: bool, page_count: int }
"""
import sys
import json
import pdfplumber

def extract_tables(pdf_path):
    results = {
        "tables": [],
        "has_tables": False,
        "page_count": 0
    }

    with pdfplumber.open(pdf_path) as pdf:
        results["page_count"] = len(pdf.pages)

        for page_num, page in enumerate(pdf.pages):
            tables = page.extract_tables()
            if tables:
                results["has_tables"] = True
                for table in tables:
                    cleaned_rows = []
                    for row in table:
                        cleaned_row = [(cell.strip() if cell else "") for cell in row]
                        if any(cleaned_row):
                            cleaned_rows.append(cleaned_row)

                    if cleaned_rows:
                        results["tables"].append({
                            "page": page_num + 1,
                            "headers": cleaned_rows[0],
                            "rows": cleaned_rows[1:] if len(cleaned_rows) > 1 else cleaned_rows
                        })

    return results

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "PDF path required"}))
        sys.exit(1)

    try:
        result = extract_tables(sys.argv[1])
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
