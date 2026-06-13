const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const outDir = '/home/user/bill-splitter/screenshots';
  require('fs').mkdirSync(outDir, { recursive: true });

  async function setupPage(context) {
    const page = await context.newPage();
    await page.goto('http://localhost:8765/index.html');
    await page.waitForSelector('nav.tabs');

    // Seed data: 3 people, 3 bills
    await page.evaluate(() => {
      state.people = [
        { id: 'p1', name: 'Alice' },
        { id: 'p2', name: 'Bob' },
        { id: 'p3', name: 'Charlie' }
      ];
      state.bills = [
        {
          id: 'b1', date: '2025-06-10', desc: 'Hotel (2 nights)',
          mode: 'equal', payerId: 'p1', totalCents: 45000,
          participants: ['p1','p2','p3'], paid: false
        },
        {
          id: 'b2', date: '2025-06-11', desc: 'Hawker Centre Dinner',
          mode: 'equal', payerId: 'p2', totalCents: 9600,
          participants: ['p1','p2','p3'], paid: false
        },
        {
          id: 'b3', date: '2025-06-12', desc: 'Sentosa Cable Car',
          mode: 'equal', payerId: 'p3', totalCents: 7200,
          participants: ['p1','p2','p3'], paid: false
        }
      ];
      state.cur = 'S$';
      save();
      render();
    });

    // Navigate to Settle tab
    await page.click('[data-tab="settle"]');
    await page.waitForSelector('.section');
    return page;
  }

  // === LIGHT MODE ===
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await setupPage(ctx);

  // Screenshot 1: Settle page — base S$ view
  await page.screenshot({ path: path.join(outDir, '01_settle_base_SGD.png'), fullPage: true });
  console.log('Shot 1: base S$');

  // Screenshot 2: Click Rp chip — inject IDR state
  await page.evaluate(() => {
    settleFx = { to: 'Rp', rate: 11324.50, loading: false, error: false };
    renderSettle();
  });
  await page.waitForSelector('.fx-rate');
  await page.screenshot({ path: path.join(outDir, '02_settle_IDR_converter.png'), fullPage: true });
  console.log('Shot 2: IDR converter shown');

  // Screenshot 3: Scroll to top to see who-pays-whom in IDR
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(outDir, '03_settle_whoPayWhom_IDR.png'), fullPage: false });
  console.log('Shot 3: who pays whom top section IDR');

  // Screenshot 4: USD comparison
  await page.evaluate(() => {
    settleFx = { to: '$', rate: 0.7412, loading: false, error: false };
    renderSettle();
  });
  await page.waitForSelector('.fx-rate');
  await page.screenshot({ path: path.join(outDir, '04_settle_USD_comparison.png'), fullPage: true });
  console.log('Shot 4: USD comparison');

  // Screenshot 5: Reset to base (click base chip)
  await page.evaluate(() => {
    settleFx = { to: null, rate: null, loading: false, error: false };
    renderSettle();
  });
  await page.screenshot({ path: path.join(outDir, '05_settle_reset_base.png'), fullPage: true });
  console.log('Shot 5: reset to base');

  await ctx.close();

  // === DARK MODE ===
  const ctxDark = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark'
  });
  const pageDark = await setupPage(ctxDark);

  // Screenshot 6: Dark mode — IDR converter
  await pageDark.evaluate(() => {
    settleFx = { to: 'Rp', rate: 11324.50, loading: false, error: false };
    renderSettle();
  });
  await pageDark.waitForSelector('.fx-rate');
  await pageDark.screenshot({ path: path.join(outDir, '06_settle_IDR_dark.png'), fullPage: true });
  console.log('Shot 6: dark mode IDR');

  // Screenshot 7: Dark mode base view
  await pageDark.evaluate(() => {
    settleFx = { to: null, rate: null, loading: false, error: false };
    renderSettle();
  });
  await pageDark.screenshot({ path: path.join(outDir, '07_settle_base_dark.png'), fullPage: true });
  console.log('Shot 7: dark mode base');

  await ctxDark.close();
  await browser.close();
  console.log('All screenshots saved to', outDir);
})();
