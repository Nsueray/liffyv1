const ExcelJS = require('exceljs');

/**
 * Generate Excel or CSV export from rows and column definitions.
 * @param {Array} rows - Data rows from SQL query
 * @param {Array} columns - Column definitions [{header, key, width?}]
 * @param {string} sheetName - Excel sheet name
 * @param {string} format - 'xlsx' or 'csv'
 * @returns {Buffer}
 */
async function generateExport(rows, columns, sheetName, format = 'xlsx') {
  if (format === 'csv') {
    return generateCSV(rows, columns);
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = columns.map(col => ({
    header: col.header,
    key: col.key,
    width: col.width || 20
  }));

  // Style header row
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4472C4' }
  };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  rows.forEach(row => {
    const rowData = {};
    columns.forEach(col => {
      let val = row[col.key];
      // Convert arrays to comma-separated string
      if (Array.isArray(val)) val = val.join(', ');
      rowData[col.key] = val ?? '';
    });
    sheet.addRow(rowData);
  });

  // Auto-filter
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length }
  };

  return workbook.xlsx.writeBuffer();
}

/**
 * Generate CSV string from rows and column definitions.
 */
function generateCSV(rows, columns) {
  const escape = (val) => {
    if (val == null) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const header = columns.map(c => escape(c.header)).join(',');
  const lines = rows.map(row =>
    columns.map(col => {
      let val = row[col.key];
      if (Array.isArray(val)) val = val.join(', ');
      return escape(val);
    }).join(',')
  );

  return Buffer.from([header, ...lines].join('\n'), 'utf-8');
}

module.exports = { generateExport };
