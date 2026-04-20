'use strict';

const { log, safeGoto, safeScreenshot } = require('../utils');
const SELECTORS = require('../config/selectors');

/**
 * Universal Login Agent (Layer 0)
 * Attempts phone/OTP or email/password authentication.
 *
 * @param {import('playwright').Page} page
 * @param {object} config  – { targetUrl, creds: { phone, otp, email, password } }
 * @param {object} ctx     – RunContext instance (sets ctx.loggedIn on success)
 * @returns {Promise<boolean>} true if login succeeded
 */
async function loginAgent(page, config, ctx) {
  log(ctx, '🔐', 'Layer 0: Universal Login Agent starting...');

  if (!config.creds.phone && !config.creds.email) {
    log(ctx, 'ℹ️', 'Login: No credentials configured, skipping authentication');
    return false;
  }

  try {
    const loginPaths = ['/auth/login', '/login', '/signin', '/sign-in', '/account/login', '/customer/account/login'];
    let loginFound = false;
    for (const loginPath of loginPaths) {
      const resp = await safeGoto(page, `${config.targetUrl}${loginPath}`);
      if (resp && resp.status() < 400) {
        const hasForm = await page.$('form, input[type="email"], input[type="tel"], input[type="password"]');
        if (hasForm) { loginFound = true; break; }
      }
    }

    if (!loginFound) {
      await safeGoto(page, config.targetUrl);
      const loginLink = await page.$(SELECTORS.login);
      if (loginLink) {
        await loginLink.click().catch(() => {});
        await page.waitForTimeout(2000);
        loginFound = true;
      }
    }

    if (!loginFound) {
      log(ctx, '⚠️', 'Login: No login page found, skipping');
      return false;
    }
    await safeScreenshot(ctx, page, 'login_page');

    const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i], input[name="username"], #ap_email');
    const passwordInput = await page.$('input[type="password"], input[name="password"], #ap_password');
    const phoneInput = await page.$('input[type="tel"], input[placeholder*="phone" i], input[placeholder*="mobile" i], input[name*="phone" i], input[name*="mobile" i]');

    if (emailInput && passwordInput && config.creds.email && config.creds.password) {
      log(ctx, '🔐', 'Login type: Email/Password');
      await emailInput.fill(config.creds.email);
      await page.waitForTimeout(500);
      await passwordInput.fill(config.creds.password);
      await page.waitForTimeout(500);

      const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Login"), button:has-text("Submit"), #signInSubmit');
      if (submitBtn) {
        await submitBtn.click();
        log(ctx, '✅', 'Login: Submitted email/password');
      }
      await page.waitForTimeout(5000);

    } else if (phoneInput && config.creds.phone) {
      log(ctx, '🔐', 'Login type: Phone/OTP');
      await phoneInput.fill(config.creds.phone);
      await page.waitForTimeout(500);

      const checkbox = await page.$('input[type="checkbox"], .checkbox, [class*="checkbox"], [class*="terms"], [class*="agree"]');
      if (checkbox) {
        const isChecked = await checkbox.isChecked().catch(() => false);
        if (!isChecked) await checkbox.click().catch(() => {});
        log(ctx, '✅', 'Login: Terms checkbox clicked');
      }
      await page.waitForTimeout(500);

      const otpBtn = await page.$('button:has-text("OTP"), button:has-text("otp"), button:has-text("Continue"), button:has-text("Send"), button[type="submit"]');
      if (otpBtn) {
        await otpBtn.click();
        log(ctx, '✅', 'Login: Get OTP clicked');
      } else {
        log(ctx, '⚠️', 'Login: OTP button not found');
        return false;
      }
      await page.waitForTimeout(3000);
      await safeScreenshot(ctx, page, 'login_otp_page');

      const otpInputs = await page.$$('input[type="tel"], input[type="number"], input[inputmode="numeric"], input[maxlength="1"]');
      if (otpInputs.length >= 4) {
        for (let i = 0; i < Math.min(otpInputs.length, config.creds.otp.length); i++) {
          await otpInputs[i].fill(config.creds.otp[i]);
        }
        log(ctx, '✅', 'Login: OTP entered (multi-box)');
      } else {
        const otpInput = await page.$('input[placeholder*="otp" i], input[placeholder*="code" i], input[name*="otp" i], input[type="tel"]:not([value]), input[type="number"]');
        if (otpInput) {
          await otpInput.fill(config.creds.otp);
          log(ctx, '✅', 'Login: OTP entered (single box)');
        }
      }
      await page.waitForTimeout(1000);

      const verifyBtn = await page.$('button:has-text("Verify"), button:has-text("Login"), button:has-text("Submit"), button:has-text("Continue"), button[type="submit"]');
      if (verifyBtn) {
        await verifyBtn.click();
        log(ctx, '✅', 'Login: Verify clicked');
      }
      await page.waitForTimeout(5000);

    } else {
      log(ctx, '⚠️', 'Login: No matching credentials for detected login type');
      return false;
    }

    await safeScreenshot(ctx, page, 'login_after');

    const profileLink = await page.$('a[href*="profile"], a[href*="account"], [class*="user-icon"], [class*="account"], [class*="profile"], #nav-link-accountList, ._2N-Vbe');
    const logoutLink = await page.$('a:has-text("Logout"), button:has-text("Logout"), a:has-text("Sign Out"), a:has-text("Sign out")');
    if (profileLink || logoutLink) {
      ctx.loggedIn = true;
      log(ctx, '✅', 'Login: SUCCESS - Authenticated');
      return true;
    }

    const currentUrl = page.url();
    if (!currentUrl.includes('/login') && !currentUrl.includes('/signin') && !currentUrl.includes('/auth')) {
      ctx.loggedIn = true;
      log(ctx, '✅', 'Login: SUCCESS - Redirected from login page');
      return true;
    }

    log(ctx, '⚠️', 'Login: Could not verify login success, continuing...');
    return false;
  } catch (e) {
    log(ctx, '❌', `Login failed: ${e.message}`);
    return false;
  }
}

module.exports = loginAgent;
