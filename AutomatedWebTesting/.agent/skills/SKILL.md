# E-Commerce QA Agent — Full Autonomous Testing System

> Autonomous QA agent that replaces manual testers. Provide 2 URLs → get a complete bug report.
> Run: `node run-test.js <production-url> <uat-url>`

---

## 1. Agent Architecture (5 Layers)

```
┌─────────────────────────────────────────────────────────────┐
│                    QA AGENT ORCHESTRATOR                     │
│               (run-test.js — main entry point)              │
├──────────┬──────────┬──────────┬──────────┬─────────────────┤
│ LAYER 1  │ LAYER 2  │ LAYER 3  │ LAYER 4  │    LAYER 5      │
│ Discovery│ Planning │ Execution│ Analysis │   Reporting     │
│  Agent   │  Agent   │  Agent   │  Agent   │    Agent        │
├──────────┼──────────┼──────────┼──────────┼─────────────────┤
│ Crawl    │ Generate │ Run tests│ Compare  │ HTML report     │
│ Discover │ test plan│ with     │ Prod vs  │ Bug report JSON │
│ Map site │ Prioritize│ retry   │ UAT      │ Vercel deploy   │
│ Detect   │ Allocate │ Parallel │ AI visual│ Slack notify    │
│ features │ budget   │ Capture  │ Classify │                 │
│          │          │ APIs     │ bugs     │                 │
└──────────┴──────────┴──────────┴──────────┴─────────────────┘
```

### Layer 1: Discovery Agent
**Purpose:** Map the site structure before testing.
- Crawls up to 20 pages (standard) / 100 pages (deep)
- Detects features: login, cart, search, wishlist, products, forms
- Collects: nav links, footer links, product links, internal links
- Records: console errors, network errors, page status codes
- Outputs: `discovery` object with complete site map

### Layer 2: Planning Agent
**Purpose:** Generate an intelligent test plan based on discovered features.
- Creates test cases dynamically (no hardcoded list)
- Prioritizes by tier: T1 (critical) → T2 (important) → T3 (extended) → T4 (optional)
- Allocates time budget per phase
- Consults learning engine for high-risk areas from past runs
- Adds AI-suggested tests based on historical bug patterns
- Outputs: `testPlan[]` array with prioritized test cases

### Layer 3: Execution Agent
**Purpose:** Run all tests with retry logic and parallel execution.
- **Retry wrapper:** Retries flaky tests 2x before reporting as bug
- **Parallel batches:** Runs independent tests concurrently (3 pages at a time)
- **API capture:** Intercepts all XHR/fetch calls during page interactions
- **Budget-aware:** Stops gracefully when time budget runs out
- **Test types:**
  - Sanity (page loads)
  - Visual (multi-device screenshots)
  - Performance (Lighthouse audit)
  - Accessibility (axe-core)
  - User Journeys (end-to-end flows)
  - Interaction (hover, click, scroll, swipe)
  - Form Validation (empty, invalid, XSS, boundary)
  - API Comparison (response times, status codes, data)
  - Regression (structure, CSS, meta, header/footer, responsive)
  - Section Visual Diff (per-component pixelmatch)
  - Lighthouse Comparison (Prod vs UAT scores)

### Layer 4: Analysis Agent
**Purpose:** Compare results between Prod and UAT, classify bugs.
- Pixelmatch visual diff (threshold 0.10, report at 3% difference)
- Per-section comparison (header, hero, content, footer)
- DOM structure comparison (element counts, heading hierarchy)
- CSS property comparison (fonts, colors, spacing)
- API response comparison (timing, status, data differences)
- Learning engine: classify as NEW / RECURRING / FIXED / REGRESSION
- Severity assignment based on impact rules

### Layer 5: Reporting Agent
**Purpose:** Generate actionable reports.
- HTML report with side-by-side screenshots
- Bug cards with reproduction steps
- Performance scorecards (Lighthouse Prod vs UAT)
- Visual diff overlays (red highlight on differences)
- JSON bug report for CI/CD integration
- Auto-deploy to Vercel for shareable link

---

## 2. How to Run

```bash
# Compare Prod vs UAT (recommended)
node run-test.js https://production.com https://staging.com

# Single site audit
node run-test.js https://mysite.com

# Modes
node run-test.js <url1> <url2> --mode=fast      # 10 min, essential tests only
node run-test.js <url1> <url2> --mode=standard   # 20 min, full coverage (default)
node run-test.js <url1> <url2> --mode=deep        # 60 min, exhaustive testing
```

Auto-opens HTML report. Auto-deploys to Vercel if configured.

---

## 3. Test Execution Pipeline

### Phase 1: Discovery (Both Sites)
| Step | Action |
|------|--------|
| 1.1 | Launch headless browser |
| 1.2 | Crawl Prod site — collect pages, links, features, errors |
| 1.3 | Crawl UAT site — same collection |
| 1.4 | Compare site maps — identify missing/extra pages |

### Phase 2: Planning
| Step | Action |
|------|--------|
| 2.1 | Generate test cases from discovered features |
| 2.2 | Consult learning engine for historical high-risk areas |
| 2.3 | Prioritize by tier (T1 critical → T4 optional) |
| 2.4 | Allocate time budget per phase |

### Phase 3: Execution (14+ Phases)

#### TIER 1 — Critical (Always Run)
| Phase | Tests | What It Does |
|-------|-------|-------------|
| Sanity | 15 | Load every page, check HTTP status, detect soft 404s |
| Performance | 10 | Lighthouse per page (score, FCP, LCP, CLS, TBT, SI, TTI) |
| Accessibility | 10 | axe-core audit (contrast, alt text, ARIA, labels) |
| Visual | 10×3 | Screenshot on Desktop, iPhone 14 Pro, Pixel 7 |
| User Journeys | 3 | End-to-end flows (browse→cart, login→profile, search→filter) |
| Scenarios | 5-11 | SKILL.md 39 scenarios (auth, cart, PLP, PDP, header, footer) |

#### TIER 2 — Important
| Phase | Tests | What It Does |
|-------|-------|-------------|
| Interaction | 1 | Hover menus, click accordions, scroll sticky header, carousel |
| Links | 3 | Internal, footer, nav link validation |
| Errors | 2 | Console + network error audit |
| Comparison | 3 | Content, nav, footer comparison (Prod vs UAT) |
| Regression | 7 | Status, title, structure, meta, header/footer, CSS, responsive |
| Lighthouse Compare | 3 | Full Lighthouse audit on both sites, compare scores |
| Section Visual Diff | 5 | Per-section pixelmatch (header, hero, content, footer) |
| API Comparison | 1 | Intercept APIs on both sites, compare responses |
| Form Validation | varies | Empty submit, invalid input, XSS, boundary tests |

#### TIER 3-4 — Extended
| Phase | Tests | What It Does |
|-------|-------|-------------|
| CSS/Theme | 4 | CSS variables, font consistency, color scheme, broken images |
| Security | 1 | HTTPS, mixed content, exposed keys |
| Exploratory | 1 | Random nav, rapid clicks, JS error detection |
| E-Commerce Deep | varies | Cart/checkout, search, PDP, PLP, wishlist, inventory |

### Phase 4: Analysis & Reporting
| Step | Action |
|------|--------|
| 4.1 | Pixelmatch visual diff (all screenshots) |
| 4.2 | Section-level visual diff (header, hero, content, footer) |
| 4.3 | Classify bugs: NEW / RECURRING / FIXED / REGRESSION |
| 4.4 | Generate HTML report + JSON |
| 4.5 | Deploy to Vercel |

---

## 4. Devices Tested

| Device | Viewport | Type |
|--------|----------|------|
| Desktop HD | 1920×1080 | Desktop |
| Desktop | 1440×900 | Desktop |
| Laptop | 1366×768 | Desktop |
| iPad Pro | 1024×1366 | Tablet |
| iPad Mini | 768×1024 | Tablet |
| iPhone 14 Pro | 393×852 | Mobile (iOS) |
| iPhone SE | 375×667 | Mobile (iOS) |
| Pixel 7 | 412×915 | Mobile (Android) |
| Samsung Galaxy S21 | 360×800 | Mobile (Android) |

### Visual Checks Per Device
- Horizontal overflow (page scrolls sideways)
- Content cut off / overflowing viewport
- Text clipped by `overflow: hidden`
- Broken or oversized images
- Untappable elements on mobile (blocked or < 20px)

### Mobile /products Special Rule
- No scrolling — capture viewport-only screenshot (above the fold)
- All other pages: full-page screenshot with lazy-load scroll

---

## 5. Test Credentials

| Field | Value |
|-------|-------|
| Phone | 8888888888 |
| OTP | 5401 |
| Test Email | testuser@example.com |
| Test Name | Test User Automation |

---

## 6. User Journey Flows (End-to-End)

### Journey 1: Browse → Add to Cart → Checkout
```
1. Open homepage
2. Navigate to /products (PLP)
3. Click first available product → PDP
4. Select size (if available)
5. Click "Add to Bag" / "Add to Cart"
6. Verify: success toast or cart count updates
7. Navigate to cart (/cart/bag or /cart)
8. Verify: product appears in cart with correct details
9. Click "Checkout" (if available)
10. Verify: checkout page loads or login redirect
```
**Bugs to detect:** Add-to-cart failure, empty cart after add, missing product in cart, checkout broken

### Journey 2: Login → Profile → Address
```
1. Navigate to login page
2. Enter phone: 8888888888
3. Accept terms, click "Get OTP"
4. Enter OTP: 5401, verify
5. Verify: logged in, profile accessible
6. Navigate to /profile/addresses
7. Check address list loads
8. Navigate to /profile/orders
9. Check orders page loads
10. Logout → verify logged out
```
**Bugs to detect:** Login failure, OTP rejection, profile not loading, logout broken

### Journey 3: Search → Filter → Product
```
1. Click search bar
2. Type "shirt" or first discovered product keyword
3. Verify: search suggestions appear
4. Press Enter → verify results page
5. Apply a filter (if available)
6. Verify: results update
7. Click first product → verify PDP loads
8. Go back → verify PLP state preserved
```
**Bugs to detect:** Search broken, no suggestions, filters don't work, back navigation broken

---

## 7. Interaction Tests

| Test | What It Checks |
|------|---------------|
| **Mega Menu Hover** | Hover L1 nav items → verify L2 dropdown appears with links |
| **Accordion/Collapse** | Click expandable sections (FAQ, size guide) → verify content shows/hides |
| **Sticky Header** | Scroll down → verify header stays fixed at top |
| **Carousel/Slider** | Check hero banner → click next/prev or verify auto-slide |
| **Modal/Popup** | Trigger modals (size guide, offers) → verify opens and closes |
| **Back to Top** | Scroll down → verify "back to top" button appears and works |
| **Infinite Scroll** | On PLP, scroll down → verify more products load |
| **Tab Switching** | Click tab elements → verify content switches |

---

## 8. API Capture & Comparison

During page interactions, the agent intercepts all XHR/fetch calls and compares:

| Metric | What It Checks |
|--------|---------------|
| **Status Codes** | 200 on Prod but 500 on UAT? |
| **Response Time** | API taking 3x longer on UAT? |
| **Response Data** | Product count different? Prices different? |
| **Failed Requests** | APIs that fail on UAT but work on Prod |
| **New APIs** | APIs called on UAT but not Prod (or vice versa) |

---

## 9. Form Validation Tests

For every discovered form (contact, login, newsletter, address):

| Test | Input | Expected |
|------|-------|----------|
| Empty submit | All fields empty | Validation errors shown |
| Invalid email | "notanemail" | Email validation error |
| Invalid phone | "abc123" | Phone validation error |
| Short input | 1 character | Min-length validation |
| Long input | 500+ characters | Max-length handling |
| XSS payload | `<script>alert(1)</script>` | Input sanitized, no alert |
| SQL injection | `'; DROP TABLE--` | Input sanitized |
| Valid submit | All valid data | Success message or redirect |

---

## 10. Retry & Flaky Test Handling

```
withRetry(testFn, { maxRetries: 2, retryDelay: 2000 })
```

| Behavior | Rule |
|----------|------|
| Network timeout | Retry 2x before reporting |
| Element not found | Retry 1x (page may still be loading) |
| Screenshot failure | Retry 1x |
| Consistent failure | Report as real bug |
| Intermittent failure | Mark as "flaky" in report |
| Page load > 10s | NOT a bug (user preference) |

---

## 11. Bug Severity & Categories

### Severity Levels
| Severity | Code | Definition | SLA |
|----------|------|-----------|-----|
| **Critical** | P0 | Core functionality broken, site unusable | Immediate fix |
| **High** | P1 | Major feature broken, significant user impact | Fix within sprint |
| **Medium** | P2 | Minor feature issue, workaround exists | Fix in next release |
| **Low** | P3 | Cosmetic issue, minimal user impact | Backlog |

### What Triggers Each Severity

**Critical:**
- Pages returning 404 that should exist (homepage, PLP, cart, checkout, login)
- PLP showing zero products when products exist
- Cart/checkout flow completely broken
- Site crash or white screen
- User journey flow completely blocked

**High:**
- Login flow failures
- Add-to-cart not working
- Missing OG tags / SEO metadata
- Lighthouse score drop > 10 points vs Prod
- LCP > 4s, FCP > 3s
- Header/footer structure missing vs Prod
- Visual diff > 25% between Prod and UAT
- API failures (5xx responses)
- User journey step fails

**Medium:**
- Font/CSS differences between Prod and UAT
- Visual diff 3-25% between Prod and UAT
- Form validation missing
- Navigation differences
- UI alignment issues on specific devices
- CLS > 0.25, TBT > 600ms
- API response time 3x slower than Prod
- Interaction test failures (hover menus, accordions)

**Low:**
- Missing alt text on images
- Minor accessibility issues
- Undefined CSS variables (when UI looks correct)

### Bug Categories
`Routing` · `E-Commerce` · `CSS/Theme` · `Auth` · `Forms` · `UI Alignment` · `Visual Diff` · `Regression` · `Performance` · `SEO/Meta` · `Responsive` · `Navigation` · `Footer` · `Accessibility` · `Content` · `Search` · `User Journey` · `Interaction` · `API`

### Bug Report Format
Each bug includes:
```
ID          → BUG-001
Severity    → Critical / High / Medium / Low
Category    → From list above
Title       → Plain English description
Description → What's wrong, impact, specific details
Location    → Page path + device (if applicable)
Steps       → Numbered reproduction steps
Expected    → What should happen
Actual      → What actually happens
Screenshot  → Visual evidence
Fix         → Recommended action
```

### What Is NOT a Bug
- Slow page loads (> 10s) — not reported per user preference
- Small touch targets (< 44px but > 20px) — guideline, not bug
- Small text — only report if unreadable
- Console errors — not reported unless they cause visible issues
- Network errors — not reported unless they cause visible issues

---

## 12. Parallel Execution Strategy

```
Sequential (dependencies):
  Discovery → Planning → [Parallel Execution] → Analysis → Reporting

Parallel within Execution:
  Batch 1: [Page1 sanity, Page2 sanity, Page3 sanity]  (3 concurrent)
  Batch 2: [Page1 perf, Page2 perf, Page3 perf]        (3 concurrent)
  Batch 3: [Desktop visual, iPhone visual, Pixel visual] (3 concurrent)
  Sequential: User journeys (depend on state)
  Sequential: Interaction tests (depend on UI state)
```

---

## 13. Regression Comparison (Prod vs UAT)

| Test | Compares |
|------|----------|
| **Page Status** | Same path returns different HTTP status |
| **Page Title** | Title text differs |
| **DOM Structure** | Element counts (images, buttons, links, headings, sections, banners) |
| **Meta Tags** | Title, description, OG tags, favicon, robots |
| **Header/Footer** | Nav links, logo, search/cart/account icons, social links, newsletter |
| **CSS Properties** | Font families, sizes, colors, button styles, nav styles |
| **Responsive** | Behavior at 375px, 768px, 1440px breakpoints |
| **Lighthouse Scores** | Performance, Accessibility, Best Practices, SEO |
| **Core Web Vitals** | FCP, LCP, CLS, TBT, Speed Index, TTI |
| **Visual Sections** | Header, hero, content, footer pixelmatch |
| **API Responses** | Status codes, response times, data differences |

---

## 14. Output Files

| File | Format | Contents |
|------|--------|----------|
| `reports/full-comparison-report.html` | HTML | Full visual report with screenshots, bug cards, performance |
| `reports/bug-report.json` | JSON | Machine-readable bug data |
| `screenshots/` | PNG | All captured screenshots |
| `learning-data/` | JSON | Historical run data for trend analysis |

---

## 15. Reference Test Flows (39 Scenarios)

These are exact step-by-step flows the agent executes. See scenario details below.

### Scenario ↔ Test Module Mapping

| # | Scenario | Function |
|---|----------|----------|
| 1 | Login, Search, Cart, COD, Cancel | `runUserJourneyBrowseToCart` + `runLoginTest` |
| 2 | Empty Cart & Return to HomePage | `runEmptyCartTest` |
| 3 | Update Address | `runAddressTest` |
| 4 | Contact Us | `runFormValidationTest` |
| 5 | Pincode Check PDP | `runPDPDeepTest` |
| 6 | Add & Delete Address | `runAddressTest` |
| 7 | Incorrect Mobile | `runAuthNegativeTests` |
| 8 | Filter by Gender | `runPLPInteractionTest` |
| 9 | PLP Product Cards | `runPLPDeepTest` |
| 10 | Footer Links | `runLinkValidation` |
| 11 | Empty Cart Message | `runEmptyCartTest` |
| 12 | Add to Cart from PLP | `runPLPInteractionTest` |
| 13 | TOS & Privacy Links | `runAuthNegativeTests` |
| 14 | Store Locator | `runStoreLocatorTest` |
| 15 | Multiple Products PDP | `runPDPDeepTest` |
| 16 | PDP Page Load | `runPDPDeepTest` |
| 17 | Login Page UI | `runLoginTest` |
| 18 | Banner Carousel | `runInteractionTest` |
| 19 | Empty Mobile Validation | `runAuthNegativeTests` |
| 20 | Size Guide PDP | `runPDPEdgeCaseTest` |
| 21 | Login & Logout | `runUserJourneyLoginToProfile` |
| 22 | Newsletter | `runNewsletterTest` |
| 23 | Track Order | `runTrackOrderTest` |
| 24 | Header Links | `runHeaderNavTest` |
| 25 | PLP Page | `runPLPDeepTest` |
| 26 | Social Media Icons | `runHomepageDeepTest` |
| 27 | HomePage Headers | `runHomepageDeepTest` |
| 28 | Add to Cart No Size | `runPDPEdgeCaseTest` |
| 29 | Sort Functionality | `runPLPInteractionTest` |
| 30 | Cart Qty +/- | `runCartQuantityTest` |
| 31 | Incorrect OTP | `runAuthNegativeTests` |
| 32 | Search & Suggestions | `runUserJourneySearchToProduct` |
| 33 | Login Checkbox | `runAuthNegativeTests` |
| 34 | Resend OTP | `runAuthNegativeTests` |
| 35 | Filter by Colour | `runPLPInteractionTest` |
| 36 | Pincode No Size | `runPDPEdgeCaseTest` |
| 37 | Empty Cart Return | `runEmptyCartTest` |
| 38 | Header L1/L2 Menus | `runInteractionTest` |
| 39 | PLP Page | `runPLPDeepTest` |

### Expected Texts & Assertions Reference

| Scenario | Expected Text/Assertion |
|----------|------------------------|
| Pincode Check PDP | "Will be delivered between" after entering 400001 |
| Empty Cart | "There are no items in your cart" |
| Incorrect Phone | "Please enter valid phone number" after entering 0000000000 |
| Contact Form Submit | Toast: "Form Submitted Successfully" |
| PLP Quick Add | "Quick add" on hover; "Product added to cart successfully" toast |
| Store Locator | "Store Locator" title; "Find a store near you" input |
| TOS Link | Redirects to `/sections/terms-and-conditions` |
| Privacy Link | Redirects to `/sections/privacy-policy` |

---

## 16. Testing Rules

1. **Prod is reference** — only UAT bugs are reported in 2-URL mode
2. **User journeys first** — test flows that matter to customers
3. **Retry before reporting** — flaky ≠ bug
4. **Plain English bugs** — never raw CSS selectors, always human-readable
5. **Screenshot evidence** — every bug must have a screenshot
6. **No false positives** — slow loads (>10s) are NOT bugs
7. **No small touch targets** — only report truly untappable elements (<20px)
8. **Compare everything** — structure, CSS, meta, visuals, APIs, performance
9. **Budget-aware** — stop gracefully, don't crash mid-test
10. **Learn from history** — prioritize areas that had bugs before
