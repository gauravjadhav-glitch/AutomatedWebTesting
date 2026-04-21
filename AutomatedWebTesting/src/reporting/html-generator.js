'use strict';

// Re-export the existing report-generator.js
// This wraps it so reporting logic stays in src/reporting/
const generateReport = require('../../report-generator');

module.exports = generateReport;
