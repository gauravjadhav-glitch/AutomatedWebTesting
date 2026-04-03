const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITE = 'https://lamartina.fynd.io';
const VIEWPORT = { width: 3840, height: 2160 }; // 4K UHD
const SCREENSHOT_DIR = path.join(__dirname, '4k-screenshots');

const PAGES = [
  '/',
  '/products',
  '/cart',
  '/auth/login',
  '/contact-us',
  '/collections',
  '/categories',
];

(async () => {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });
  
  const bugs = [];
  
  for (const pagePath of PAGES) {
    const url = SITE + pagePath;
    const pageName = pagePath === '/' ? 'homepage' : pagePath.replace(/\//g, '_').slice(1);
    console.log(`\n--- Checking ${url} at 4K (3840x2160) ---`);
    
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch { 
        console.log(`  SKIP: Could not load ${url}`);
        await page.close();
        continue;
      }
    }
    await page.waitForTimeout(2000);
    
    // Take full page screenshot
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${pageName}_4k.png`), fullPage: true });
    
    // Check for UI bugs at 4K
    const uiBugs = await page.evaluate(() => {
      const issues = [];
      const vw = window.innerWidth; // 3840
      
      // 1. Check for elements not stretching to full width (large gaps on sides)
      const body = document.body;
      const bodyWidth = body.scrollWidth;
      if (bodyWidth < vw * 0.9) {
        issues.push({ type: 'Layout', desc: `Page content width (${bodyWidth}px) is much narrower than 4K viewport (${vw}px) — large empty gaps on sides` });
      }
      
      // 2. Check max-width containers that leave too much whitespace
      const containers = document.querySelectorAll('[class*="container"], [class*="wrapper"], [class*="layout"], main, [class*="content"]');
      containers.forEach(el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const maxW = parseInt(style.maxWidth);
        if (maxW && maxW < 1600 && rect.height > 100) {
          const gapPercent = ((vw - maxW) / vw * 100).toFixed(0);
          if (gapPercent > 40) {
            issues.push({ type: 'Layout', desc: `Container "${el.className.slice(0,60)}" has max-width ${maxW}px — ${gapPercent}% of 4K screen is empty whitespace` });
          }
        }
      });
      
      // 3. Check images that are too small / blurry at 4K
      const images = document.querySelectorAll('img');
      images.forEach(img => {
        const rect = img.getBoundingClientRect();
        if (rect.width > 200 && img.naturalWidth > 0) {
          if (img.naturalWidth < rect.width * 0.5) {
            issues.push({ type: 'Image Quality', desc: `Image "${(img.alt || img.src.split('/').pop()).slice(0,50)}" rendered at ${Math.round(rect.width)}px but natural size is only ${img.naturalWidth}px — will appear blurry at 4K` });
          }
        }
      });
      
      // 4. Check for text that's too small at 4K
      const textElements = document.querySelectorAll('p, span, a, li, td, th, label, div');
      let tinyTextCount = 0;
      textElements.forEach(el => {
        const style = getComputedStyle(el);
        const fontSize = parseFloat(style.fontSize);
        if (fontSize > 0 && fontSize < 12 && el.textContent.trim().length > 2 && el.offsetHeight > 0) {
          tinyTextCount++;
        }
      });
      if (tinyTextCount > 5) {
        issues.push({ type: 'Typography', desc: `${tinyTextCount} text elements have font-size below 12px — may be hard to read on 4K display` });
      }
      
      // 5. Check for horizontal scroll issues
      if (document.documentElement.scrollWidth > vw + 5) {
        issues.push({ type: 'Layout', desc: `Horizontal scroll detected at 4K — page is ${document.documentElement.scrollWidth}px wide vs ${vw}px viewport` });
      }
      
      // 6. Check for elements overflowing viewport
      const allVisible = document.querySelectorAll('header, nav, footer, section, [class*="banner"], [class*="hero"], [class*="slider"]');
      allVisible.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.left + rect.width < vw * 0.5 && rect.width < vw * 0.6 && rect.height > 50) {
          issues.push({ type: 'UI Alignment', desc: `"${el.tagName.toLowerCase()}${el.className ? '.' + el.className.split(' ')[0].slice(0,30) : ''}" only covers ${Math.round(rect.width/vw*100)}% of viewport width at 4K — content appears left-aligned with large right gap` });
        }
      });
      
      // 7. Check buttons that are disproportionately small
      const buttons = document.querySelectorAll('button, a[class*="btn"], [class*="button"], input[type="submit"]');
      let tinyButtons = 0;
      buttons.forEach(btn => {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 80 && rect.height < 30 && rect.height > 0) {
          tinyButtons++;
        }
      });
      if (tinyButtons > 3) {
        issues.push({ type: 'UI Alignment', desc: `${tinyButtons} buttons are very small (<80px wide) at 4K resolution — may be hard to find and click` });
      }
      
      // 8. Check for background images not covering at 4K
      const bgElements = document.querySelectorAll('[class*="hero"], [class*="banner"], [class*="slider"], [class*="bg"]');
      bgElements.forEach(el => {
        const style = getComputedStyle(el);
        const bgImage = style.backgroundImage;
        const bgSize = style.backgroundSize;
        if (bgImage && bgImage !== 'none' && bgSize !== 'cover' && bgSize !== '100%') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 500 && rect.height > 100) {
            issues.push({ type: 'Image Quality', desc: `Background on "${el.className.slice(0,40)}" may not scale properly at 4K (background-size: ${bgSize})` });
          }
        }
      });
      
      // 9. Check nav/header full width
      const header = document.querySelector('header') || document.querySelector('nav');
      if (header) {
        const rect = header.getBoundingClientRect();
        if (rect.width < vw * 0.95) {
          issues.push({ type: 'Layout', desc: `Header/Nav is only ${Math.round(rect.width)}px wide — doesn't span full 4K viewport (${vw}px)` });
        }
      }
      
      // 10. Check footer full width
      const footer = document.querySelector('footer');
      if (footer) {
        const rect = footer.getBoundingClientRect();
        if (rect.width < vw * 0.95) {
          issues.push({ type: 'Layout', desc: `Footer is only ${Math.round(rect.width)}px wide — doesn't span full 4K viewport (${vw}px)` });
        }
      }
      
      return issues;
    });
    
    if (uiBugs.length > 0) {
      console.log(`  Found ${uiBugs.length} UI issues:`);
      uiBugs.forEach(b => {
        console.log(`    [${b.type}] ${b.desc}`);
        bugs.push({ page: pagePath, ...b });
      });
    } else {
      console.log(`  No 4K-specific UI issues found`);
    }
    
    await page.close();
  }
  
  await browser.close();
  
  console.log(`\n\n========================================`);
  console.log(`4K UI BUG SUMMARY — lamartina.fynd.io`);
  console.log(`========================================`);
  console.log(`Total 4K-specific bugs: ${bugs.length}`);
  bugs.forEach((b, i) => {
    console.log(`\n${i+1}. [${b.type}] Page: ${b.page}`);
    console.log(`   ${b.desc}`);
  });
  console.log(`\nScreenshots saved to: ${SCREENSHOT_DIR}`);
})();
