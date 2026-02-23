// Standalone test — sadece miner'ı çağırır, DB'ye yazmaz
const { runMesseFrankfurtMiner } = require('../services/urlMiners/messeFrankfurtMiner');
const { chromium } = require('playwright');

async function test() {
  const url = 'https://techtextil.messefrankfurt.com/frankfurt/en/exhibitor-search.html?page=1&pagesize=30';

  console.log('Testing messeFrankfurtMiner...');
  console.log('URL:', url);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    const config = { max_pages: 2, max_details: 5, delay_ms: 1500 };  // küçük test
    const results = await runMesseFrankfurtMiner(page, url, config);

    console.log(`\nResults: ${results.length} exhibitors`);
    console.log('\nFirst 3 results:');
    results.slice(0, 3).forEach((r, i) => {
      console.log(`\n--- Exhibitor ${i+1} ---`);
      console.log('Company:', r.company_name);
      console.log('Email:', r.email);
      console.log('Phone:', r.phone);
      console.log('Website:', r.website);
      console.log('Country:', r.country);
      console.log('Address:', r.address);
    });
  } catch (err) {
    console.error('ERROR:', err.message);
    console.error(err.stack);
  } finally {
    await browser.close();
  }
}

test();
