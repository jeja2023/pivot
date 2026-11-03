'use strict';

const XLSX = require('@e965/xlsx');

function extractExcelPreviewData(filePath, options = {}) {
    const workbook = XLSX.readFile(filePath, { cellDates: true, dense: true });
    const sheetNames = workbook.SheetNames || [];
    if (!sheetNames.length) {
        throw new Error('Excel 工作簿中没有发现任何工作表。');
    }
    const maxRows = options.maxRows || 200;
    const maxCols = options.maxCols || 50;

    const sheets = [];
    for (const name of sheetNames.slice(0, 15)) {
        const sheet = workbook.Sheets[name];
        if (!sheet) continue;
        const ref = sheet['!ref'];
        if (!ref) {
            sheets.push({ name, rows: [], empty: true });
            continue;
        }
        const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
        const slicedRows = rawRows.slice(0, maxRows).map(row => {
            const arr = Array.isArray(row) ? row : [];
            return arr.slice(0, maxCols).map(cell => {
                if (cell == null) return '';
                if (cell instanceof Date) return cell.toISOString().slice(0, 10);
                return String(cell);
            });
        });
        sheets.push({
            name,
            totalRows: rawRows.length,
            isTruncated: rawRows.length > maxRows,
            rows: slicedRows
        });
    }

    return {
        sheetNames,
        sheets
    };
}

module.exports = { extractExcelPreviewData };

