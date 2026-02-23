/**
 * Test script for memberTableMiner
 *
 * Usage:
 *   node backend/scripts/test_member_table_miner.js [url]
 *
 * Default URL: https://www.aiacra.com/members.php?key=patron-members
 */

const { chromium } = require('playwright');
const { runMemberTableMiner } = require('../services/urlMiners/memberTableMiner');

const DEFAULT_URL = 'https://www.aiacra.com/members.php?key=patron-members';

async function main() {
  const url = process.argv[2] || DEFAULT_URL;

  console.log('='.repeat(60));
  console.log('memberTableMiner Test');
  console.log('='.repeat(60));
  console.log(`URL: ${url}`);
  console.log();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    const startTime = Date.now();
    const results = await runMemberTableMiner(page, url, {});
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n' + '='.repeat(60));
    console.log(`RESULTS: ${results.length} contacts in ${elapsed}s`);
    console.log('='.repeat(60));

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      console.log(`\n--- #${i + 1} ---`);
      console.log(`  Company:  ${r.company_name || '(none)'}`);
      console.log(`  Email:    ${r.email || '(none)'}`);
      console.log(`  Phone:    ${r.phone || '(none)'}`);
      console.log(`  Contact:  ${r.contact_name || '(none)'}`);
      console.log(`  City:     ${r.city || '(none)'}`);
      console.log(`  Address:  ${r.address || '(none)'}`);
      console.log(`  Website:  ${r.website || '(none)'}`);
      console.log(`  Country:  ${r.country || '(none)'}`);
    }

    // Summary
    const withEmail = results.filter(r => r.email).length;
    const withCompany = results.filter(r => r.company_name).length;
    const withContact = results.filter(r => r.contact_name).length;
    const withPhone = results.filter(r => r.phone).length;
    const withCity = results.filter(r => r.city).length;

    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`  Total:      ${results.length}`);
    console.log(`  w/ Email:   ${withEmail}`);
    console.log(`  w/ Company: ${withCompany}`);
    console.log(`  w/ Contact: ${withContact}`);
    console.log(`  w/ Phone:   ${withPhone}`);
    console.log(`  w/ City:    ${withCity}`);

  } catch (err) {
    console.error('ERROR:', err.message);
    console.error(err.stack);
  } finally {
    await browser.close();
  }
}

main();
