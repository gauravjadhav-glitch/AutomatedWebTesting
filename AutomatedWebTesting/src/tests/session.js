'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runSessionTests(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDD12', '--- Session Tests ---');
  if (!ctx.loggedIn) {
    log(ctx, '\u26A0\uFE0F', 'Session tests skipped — not logged in');
    ctx.testResults.skipped += 3;
    ctx.testResults.total += 3;
    return;
  }

  // Test session persistence after refresh
  ctx.testResults.total++;
  await safeGoto(page, config.targetUrl);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const stillLoggedIn = await page.$('a[href*="profile"], [class*="user-icon"], [class*="account"], a:has-text("Logout")');
  if (stillLoggedIn) {
    ctx.testResults.passed++;
    log(ctx, '\u2705', 'Session: Persists after refresh');
  } else {
    ctx.testResults.failed++;
    const ss = await safeScreenshot(ctx, page, 'session_lost');
    addBug(ctx, 'High', 'Session', 'Session lost after page refresh', 'User is logged out after refreshing the page', 'Homepage — Desktop', ['1. Login', '2. Refresh page'], 'Still logged in', 'Session lost', ss, 'Check session cookie persistence');
  }

  // Test profile accessible
  ctx.testResults.total++;
  const profilePage = discovery.livePages.find(p => p.path === '/profile');
  if (profilePage) {
    await safeGoto(page, profilePage.url);
    const redirected = page.url().includes('/login') || page.url().includes('/auth');
    if (redirected) {
      ctx.testResults.failed++;
      const ss = await safeScreenshot(ctx, page, 'profile_redirect');
      addBug(ctx, 'High', 'Session', 'Profile redirects to login despite being authenticated', 'Accessing /profile redirects to login page', '/profile — Desktop', ['1. Login', '2. Navigate to /profile'], 'Profile page loads', 'Redirected to login', ss, 'Check auth middleware for profile route');
    } else {
      ctx.testResults.passed++;
      log(ctx, '\u2705', 'Session: Profile accessible');
    }
  }
}

module.exports = runSessionTests;
