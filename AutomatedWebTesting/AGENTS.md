# Fynd QA Agent Workspace

## Project Overview
Automated testing and UI validation framework for Fynd-based ecommerce frontends (Production vs UAT).
Uses Playwright for browser testing and the Fynd GraphQL MCP Server for API validations.

## How to Run
```bash
node run-test.js <site1-url> <site2-url>
```

## Testing Rules
- Always prioritize checkout, PDP, and login flows
- Compare UAT vs PROD behavior meticulously
- Report all bugs using the structured bug report format
- Test on Desktop, iPhone 14, and Pixel 7 devices

## Agent Skill
All testing knowledge is consolidated in a single file:
- **`.agent/skills/SKILL.md`** — Complete QA reference: test pipeline, bug categories, known patterns, regression checklist, API queries, test credentials, and output formats
