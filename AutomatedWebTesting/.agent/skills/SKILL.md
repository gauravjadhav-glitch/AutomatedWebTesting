# E-Commerce Autonomous Testing Agent — Final Spec

> Autonomous QA agent that replaces manual testers. Provide URL(s) → get a complete bug report.
> Run: `node run-test.js <url> [--mode=fast|standard|deep]`

---

## 1. Agent Architecture (5 Layers)

```
┌─────────────────────────────────────────────────────────────┐
│                    QA AGENT ORCHESTRATOR                     │
│               (run-test.js — main entry point)              │
├──────────┬──────────┬──────────┬──────────┬─────────────────┤
│ LAYER 0  │ LAYER 1  │ LAYER 2  │ LAYER 3  │    LAYER 4      │
│ Login    │ Discovery│ Planning │ Execution│   Reporting     │
│ Agent    │  Agent   │  Agent   │  Agent   │    Agent        │
├──────────┼──────────┼──────────┼──────────┼─────────────────┤
│ Auth     │ Crawl    │ Generate │ Run tests│ HTML report     │
│ Login    │ Discover │ test plan│ with     │ Bug report JSON │
│ Session  │ Map site │ Prioritize│ retry   │ GitHub Pages    │
│ Context  │ Detect   │ Allocate │ Parallel │ Learning save   │
│          │ features │ budget   │ Capture  │                 │
└──────────┴──────────┴──────────┴──────────┴─────────────────┘
```

### Layer 0: Login Agent (NEW — Login First)
**Purpose:** Authenticate before discovery so all pages show real data.
- Logs in with phone (8888888888) + OTP (5401)
- Clicks terms checkbox if present
- Returns authenticated browser context
- Discovery then crawls with session cookies → /profile, /orders, /wishlist show real content
- If login fails, continues with unauthenticated crawl

### Layer 1: Discovery Agent
**Purpose:** Map the site structure before testing.
- Crawls up to 20 (fast) / 30 (standard) / 100 (deep) pages
- Detects features: login, cart, search, wishlist, products, forms
- Collects: nav links, footer links, product links, internal links
- Records: console errors (classified), network errors
- Outputs: `discovery` object with complete site map

### Layer 2: Planning Agent
**Purpose:** Generate an intelligent test plan based on discovered features.
- Creates test cases dynamically (not hardcoded)
- Prioritizes by tier: T1 (critical) → T2 (important) → T3 (extended) → T4 (optional)
- Allocates time budget per phase
- Consults learning engine for high-risk areas from past runs
- Outputs: `testPlan[]` array with prioritized test cases

### Layer 3: Execution Agent
**Purpose:** Run all tests with retry logic and parallel execution.
- **Retry wrapper:** Retries flaky tests 2x before reporting as bug
- **Parallel batches:** Runs independent tests concurrently (3 at a time)
- **API capture:** Intercepts all XHR/fetch calls during interactions
- **Budget-aware:** Stops gracefully when time runs out
- **Self-healing selectors:** Tries multiple selector alternatives per element

### Layer 4: Reporting Agent
**Purpose:** Generate actionable reports.
- HTML report with bug cards, screenshots, filters
- JSON bug report for CI/CD integration
- Auto-deploy to GitHub Pages for shareable links
- Learning engine saves run data for future optimization

---

## 2. How to Run

```bash
# Single site audit (login-first, then test everything)
node run-test.js https://mysite.com

# Compare Prod vs UAT
node run-test.js https://production.com https://staging.com

# Modes
node run-test.js <url> --mode=fast      # 10 min, essential tests
node run-test.js <url> --mode=standard   # 20 min, full coverage (default)
node run-test.js <url> --mode=deep       # 60 min, exhaustive testing
```

---

## 3. Test Execution Pipeline

### Phase 0: Login (Authenticated Crawl)
| Step | Action |
|------|--------|
| 0.1 | Navigate to /auth/login |
| 0.2 | Enter phone: 8888888888 |
| 0.3 | Click terms checkbox |
| 0.4 | Click Get OTP |
| 0.5 | Enter OTP: 5401 |
| 0.6 | Verify login — profile/logout visible |
| 0.7 | Return authenticated context for discovery |

### Phase 1: Discovery (Authenticated)
| Step | Action |
|------|--------|
| 1.1 | Crawl site with session cookies |
| 1.2 | Probe all paths (see Probe Paths below) |
| 1.3 | Collect pages, links, features, errors, forms |
| 1.4 | Profile/orders/wishlist now show real data |

#### All Probe Paths
```
/                    /products            /collections         /categories
/auth/login          /auth/register       /login               /register
/profile             /profile/details     /profile/orders      /profile/addresses
/profile/phone       /profile/email       /profile/wishlist
/cart                /cart/bag            /checkout
/wishlist            /favourites
/contact-us          /contact
/about               /about-us
/faq                 /faqs
/terms-and-conditions                     /sections/terms-and-conditions
/privacy-policy                           /sections/privacy-policy
/return-policy       /refund-policy
/shipping-policy     /delivery
/blog                /store-locator       /locate-us
/size-guide          /gift-cards
/offers              /deals               /sale               /coupons
```

### Phase 2: Test Plan Generation
| Step | Action |
|------|--------|
| 2.1 | Generate tests from discovered features |
| 2.2 | Sanity → Top 20 pages |
| 2.3 | Visual → Top 20 pages × 4 devices |
| 2.4 | Links → All internal/nav/footer |
| 2.5 | Forms → Validation per form |
| 2.6 | E-Commerce → PLP, PDP, Cart, Checkout |
| 2.7 | Learning engine → Prioritized high-risk paths |

### Phase 3: Execution

#### TIER 1 — Always Runs
| Phase | Tests | What It Does |
|-------|-------|-------------|
| Sanity | 20 | Load every page, check HTTP status, detect soft 404s |
| Performance | 10 | Lighthouse per page (FCP, LCP, CLS, TBT) |
| Accessibility | 10 | axe-core audit (contrast, alt text, ARIA, labels) |
| Visual | 20×4 | Screenshot on Desktop, 4K UHD, iPhone 14 Pro, Pixel 7 |
| E-Commerce Core | varies | PLP products, cart state, PDP deep, checkout |
| Auth | 3 | Login flow, login+scroll validation, protected pages |
| Search Deep | 1 | Dynamic keyword, autocomplete, results, edge cases |
| User Journeys | 3 | Browse→Cart, Login→Profile, Search→Product |
| Scenarios | 5-11 | 45 scenarios mapped to test functions |

#### TIER 2 — Standard / Deep
| Phase | Tests | What It Does |
|-------|-------|-------------|
| Interaction | 5 | Mega menu, sticky header, carousel, back-to-top, tabs |
| Link Validation | 3 | Internal, footer, nav links |
| Error Auditing | 2 | Console errors (classified), network failures |
| 4K UHD | 18 | 3840×2160 resolution checks (scroll, blur, tiny, PDP) |
| **Session** | 1 | Persist after refresh, cart after login, logout clears |
| **Payment** | 2 | COD/UPI/Card methods, failure handling |
| **Order Lifecycle** | 1 | Order history, detail view, cancel/return |
| **Pricing** | 1 | Item total = cart total, discount, tax validation |
| **Race Conditions** | 1 | Double-click ATC, rapid qty change, multi-tab cart |
| Form Validation | varies | Empty, invalid email, XSS, SQL injection |
| SEO | 3 | robots.txt, sitemap, structured data, meta tags |
| Security Headers | 1 | CSP, HSTS, X-Frame, mixed content |
| Comparison | 7 | Status, title, structure, meta, CSS, responsive (2-URL) |
| API Comparison | 1 | Intercept APIs, compare responses (2-URL) |

#### TIER 3-4 — Deep Only
| Phase | Tests | What It Does |
|-------|-------|-------------|
| CSS/Theme | 4 | Variables, fonts, colors, broken images |
| Wishlist | 1 | Wishlist add/remove, persistence |
| Security | 1 | HTTPS, mixed content, exposed keys |
| Exploratory | 1 | Random navigation, rapid clicks, JS errors |
| Inventory | 1 | Stock availability, out-of-stock UX |

### Phase 4: Analysis & Reporting
| Step | Action |
|------|--------|
| 4.1 | Deduplicate bugs by severity + title |
| 4.2 | Classify: NEW / RECURRING / FIXED / REGRESSION |
| 4.3 | Generate HTML report + JSON export |
| 4.4 | Deploy to GitHub Pages |
| 4.5 | Save learning data for next run |

---

## 4. Devices Tested

| Device | Viewport | Type |
|--------|----------|------|
| Desktop | 1440×900 | Desktop |
| **4K UHD** | **3840×2160** | **Desktop (Large)** |
| iPhone 14 Pro | 393×852 | Mobile (iOS) |
| Pixel 7 | 412×915 | Mobile (Android) |

### Visual Checks Per Device
- Horizontal overflow (page scrolls sideways)
- Content cut off / overflowing viewport
- Broken or oversized images
- Untappable elements on mobile (< 25px)
- Blurry images (upscaled > 2x at 4K)
- Excessive whitespace at 4K
- Nav/content width coverage at 4K

---

## 5. Test Credentials

| Field | Value |
|-------|-------|
| Phone | 8888888888 |
| OTP | 5401 |
| Pincode | 400001 |

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
8. Verify: product appears in cart
9. Click "Checkout" (if available)
10. Verify: checkout page loads or login redirect
```

### Journey 2: Login → Profile → Orders
```
1. Navigate to /auth/login
2. Enter phone: 8888888888
3. Click terms checkbox
4. Click "Get OTP"
5. Enter OTP: 5401, verify
6. Verify: logged in, profile accessible
7. Navigate to /profile/orders
8. Check orders page loads
9. Logout → verify logged out
```

### Journey 3: Search → Filter → Product
```
1. Click search bar
2. Type dynamic keyword (from discovered products)
3. Verify: suggestions appear
4. Press Enter → verify results
5. Apply filter (if available)
6. Click product → verify PDP loads
```

### Journey 4: Login + Scroll Validation (NEW)
```
1. Go to /auth/login
2. Enter phone: 8888888888
3. Click checkbox
4. Click Get OTP
5. Enter OTP: 5401
6. Verify login: profile OR logout visible
7. Scroll 500px → no UI break
8. Scroll 1500px → images load (lazy loading works)
9. Scroll bottom → no crash
10. Refresh → session persists
11. Click product → PDP loads (optional)
```

---

## 7. New Test Categories

### Payment Tests
| Test | What It Checks |
|------|---------------|
| Payment Methods | COD, UPI, Card options visible on checkout |
| COD Selection | Can select Cash on Delivery |
| Place Order Button | Visible and clickable after payment selection |
| Payment Failure | Error handling when payment fails |

### Order Lifecycle
| Test | What It Checks |
|------|---------------|
| Orders Page | /profile/orders accessible after login |
| Order History | Previous orders listed or empty state shown |
| Order Detail | Click order → order ID visible |
| Cancel/Return | Cancel/return button present (if applicable) |

### Pricing Validation
| Test | What It Checks |
|------|---------------|
| Item Total | Sum of item prices × quantities |
| Cart Total | Item total - discount + tax = displayed total |
| Discount | Coupon/discount applied correctly |
| Tax | GST/tax calculated correctly |

### Session Tests
| Test | What It Checks |
|------|---------------|
| Persist after refresh | Reload page → still logged in |
| Cart after login | Cart accessible while authenticated |
| Profile accessible | /profile loads without redirect |
| Logout clears session | After logout, /profile redirects to login |

### Race Conditions
| Test | What It Checks |
|------|---------------|
| Double-click ATC | No duplicate items or crash |
| Rapid qty change | 3 rapid + clicks → no server error |
| Multi-tab cart | Cart loads in separate browser session |

---

## 8. Interaction Tests

| Test | What It Checks |
|------|---------------|
| **Mega Menu Hover** | Hover L1 nav items → L2 dropdown appears |
| **Sticky Header** | Scroll down → header stays fixed at top |
| **Carousel/Slider** | Hero banner → click next/prev or auto-slide |
| **Back to Top** | Scroll down → button appears and works |
| **Tab Switching** | Click tab → content switches |

---

## 9. 4K UHD Tests (3840×2160)

| # | Check | Severity | Trigger |
|---|-------|----------|---------|
| 1 | Horizontal scroll | Critical | scrollWidth > viewport + 10px |
| 2 | Nav width | High | Nav < 50% of 3840px (site-wide) |
| 3 | Blurry images | High | Source < rendered × 0.5, > 200px |
| 4 | Untappable elements | High | < 25px tall, visible, >= 2 found |
| 5 | Broken images | Critical | naturalWidth === 0 (excludes SVG/data:) |
| 6 | Footer links size | Medium | > 3 links < 20px tall |
| 7 | Missing alt text | Medium | >= 3 large images without alt |
| 8 | Excessive whitespace | High | Content < 40% of viewport |
| 9 | Focus indicators | High | >= 80% elements lack focus style |
| 10 | Color contrast | High | > 30% text fails WCAG 4.5:1 |
| 11 | Header icons | High | Cart/Account/Search missing |
| 12 | Page weight | Medium | Total > 5MB |
| 13 | PDP: Size selector | Critical | Not found/visible |
| 14 | PDP: ATC button | Critical | Not found/visible |
| 15 | PDP: Gallery nav | High | No arrows or thumbnails |
| 16 | PDP: Price | High | Not visible |
| 17 | PDP: Description | Medium | < 20 chars |
| 18 | Search results | Medium | Zero results for "shirt" |

---

## 10. Form Validation Tests

| Test | Input | Expected |
|------|-------|----------|
| Empty submit | All fields empty | Validation errors shown |
| Invalid email | "notanemail" | Email validation error |
| Invalid phone | "abc" | Phone validation error |
| XSS payload | `<script>alert(1)</script>` | Input sanitized |
| SQL injection | `'; DROP TABLE--` | Input sanitized |

---

## 11. Bug Severity & Categories

### Severity Levels
| Severity | Definition | Examples |
|----------|-----------|---------|
| **Critical** | Revenue blocker, site unusable | 404 on homepage, cart broken, ATC fails, checkout crash |
| **High** | Major UX break, feature broken | Login fails, payment methods missing, session lost |
| **Medium** | Minor issue, workaround exists | Font diff, form validation missing, alignment issues |
| **Low** | Cosmetic, minimal impact | Missing alt text, minor CSS issues |

### Bug Categories
`Routing` · `E-Commerce` · `CSS/Theme` · `Auth` · `Forms` · `UI Alignment` · `Visual Diff` · `Regression` · `Performance` · `SEO/Meta` · `Responsive` · `Navigation` · `Footer` · `Accessibility` · `Content` · `Search` · `User Journey` · `Interaction` · `API` · `Payment` · `Session` · `Image Quality` · `4K Responsive` · `UI Functionality`

### Bug Report Format
```
ID          → BUG-001
Severity    → Critical / High / Medium / Low
Category    → From list above
Title       → Plain English description
Description → What's wrong + impact
Location    → Page path + device
Steps       → Numbered reproduction steps
Expected    → What should happen
Actual      → What actually happens
Screenshot  → Visual evidence
Fix         → Recommended action
```

---

## 12. Reference Test Flows (45 Scenarios)

### Scenario → Test Module Mapping

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
| 13 | TOS & Privacy Links | `runPolicyPagesTest` |
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
| 39 | **Login + Scroll Validation** | `runLoginAndScrollTest` |
| 40 | **Session Persistence** | `runSessionTest` |
| 41 | **Payment Methods** | `runPaymentTest` |
| 42 | **Order Lifecycle** | `runOrderLifecycleTest` |
| 43 | **Pricing Validation** | `runPricingValidationTest` |
| 44 | **Race Conditions** | `runRaceConditionTest` |
| 45 | **Coupon Validation** | `runCouponPromoTest` |

### Expected Texts & Assertions Reference

| Scenario | Expected Text/Assertion |
|----------|------------------------|
| Pincode Check PDP | "Will be delivered between" after 400001 |
| Empty Cart | "There are no items in your cart" |
| Incorrect Phone | "Please enter valid phone number" |
| Contact Form Submit | Toast: "Form Submitted Successfully" |
| PLP Quick Add | "Quick add" on hover; success toast |
| Store Locator | "Store Locator" title; "Find a store near you" |
| TOS Link | Redirects to `/sections/terms-and-conditions` |
| Privacy Link | Redirects to `/sections/privacy-policy` |
| Login + Scroll | Profile/logout visible after OTP, no crash on scroll |
| Session Persist | Still logged in after page refresh |
| Payment COD | "Cash on Delivery" option visible |
| Order History | Order cards or "no orders" empty state |
| Price Match | Item total = displayed cart total |

---

## 13. Learning Engine

| Function | What It Does |
|----------|-------------|
| `loadKnowledge()` | Load history, bug patterns, site profiles, selectors, coverage |
| `classifyBugs()` | NEW / RECURRING / FIXED / REGRESSION classification |
| `getTestPriorities()` | High-risk paths, coverage gaps, focus areas |
| `healAndFind()` | Self-healing selectors (4-8 alternatives per element) |
| `suggestNewTests()` | Coverage gaps + edge cases from history |
| `saveRunLearning()` | Persist run data for next session |
| `generateInsights()` | Quality trends, chronic bugs, regressions |

---

## 14. Testing Rules

1. **Login first** — authenticate before crawling for complete page data
2. **Prod is reference** — only UAT bugs reported in 2-URL mode
3. **User journeys first** — test flows that matter to customers
4. **Retry before reporting** — flaky ≠ bug (2x retry for transient errors)
5. **Plain English bugs** — never raw CSS selectors
6. **Screenshot evidence** — every bug must have a screenshot
7. **No false positives** — strict detection with size/visibility thresholds
8. **Budget-aware** — stop gracefully, don't crash mid-test
9. **Learn from history** — prioritize areas that had bugs before
10. **Self-healing** — try multiple selectors before failing

---

## 15. Output Files

| File | Format | Contents |
|------|--------|----------|
| `reports/full-comparison-report.html` | HTML | Full report with screenshots, bug cards, performance |
| `reports/bug-report.json` | JSON | Machine-readable bug data |
| `reports/4k-all-bugs.html` | HTML | 4K-specific bug report |
| `screenshots/` | PNG | All captured screenshots |
| `knowledge/` | JSON | Learning engine data (history, patterns, coverage) |
