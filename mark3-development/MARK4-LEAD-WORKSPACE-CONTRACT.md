# ULTRON Mark 4 Lead Workspace Contract

## Purpose

Lead Workspace is the domain owner for heavy lead-generation work. It can create a native Google Sheet, remember previous spreadsheet layouts, research public-web leads, selectively scrape public pages for business contact evidence, checkpoint long runs, resume interrupted missions, and hand only unresolved contact fields to Apollo after explicit approval.

## Natural commands

Examples:

- `Find me 100 HR recruiter leads in India and create a Google Sheet.`
- `Bring me 75 SaaS founder leads with phone and email.`
- `Build 120 fitness creator leads and use the previous sheet format.`
- `Create 50 creator leads. headers: Name, Niche, LinkedIn, Post Details, Phone, Email`
- `Lead mission status`
- `Resume lead mission`

A Google Sheet URL is not required for these missions because Lead Workspace can create the destination itself.

## Layout memory

When a new lead mission does not specify headings, ULTRON checks remembered layouts and the most recent spreadsheet used by Lead Enrichment. It asks one concise question before creating the destination:

`Your latest reusable layout from <sheet> is: <headers>. Use the previous format, use the default format, or send headers: ...`

The exact visible headings are preserved, including spacer/legacy columns. Recognized semantic roles are mapped dynamically, so layouts may move columns without breaking the mission.

The default layout is:

`Name | Company | Role | LinkedIn Profile URL | Post Details | Phone No | Email | Source`

## Research pipeline

1. Understand target/count.
2. Resolve or confirm sheet layout.
3. Create a native Google Sheet in the authenticated Google account.
4. Generate several focused public-web search queries.
5. Collect and deduplicate public LinkedIn profile URLs.
6. Parse public search-result evidence into Name, Company, Role, Post Details and any visible contact data.
7. For a bounded subset of unresolved leads, search and fetch public non-login web pages for additional business-contact evidence.
8. Write rows into the new Google Sheet.
9. If phone/email were requested and fields remain missing, ask for Apollo approval.
10. After approval, Lead Enrichment remains responsible for local-first repair, Apollo cache, live Apollo calls and async phone callbacks.

## Permission boundary

Apollo is the only current lead-workspace tool that requires an explicit approval gate because it is office-owned and credit-consuming.

Google Sheets creation, public-web research, TinyFish/direct public-page fetching, layout learning, status checks and mission resume do not require a paid-tool approval.

Public scraping must never bypass authentication, scrape private/login-gated pages, evade access controls, or probe private/local network addresses. The existing web safety layer remains authoritative.

## Heavy-task behavior

Lead Workspace supports up to 200 requested leads per mission in Mark 3. Search progress, discovered lead buffers, failures, destination metadata and mission state are persisted under `.ultron/lead-workspace/state.json` so interrupted missions can continue rather than starting from zero.

Large missions should remain sequential/lightweight on the 8 GB development machine. Do not introduce a local heavyweight model or high-concurrency crawler for this path.

## Mark 4 upgrade path

Mark 4 should move this contract into the Task Graph so lead missions become durable DAGs:

`Plan -> Layout -> Create Sheet -> Public Research -> Public Scrape -> Deduplicate -> Write -> Verify -> Apollo Gate -> Enrich -> Verify -> Complete`

Each node should be independently resumable and observable. The mission state should eventually move from JSON into the same lightweight durable task store selected for Mark 4, while keeping layout memory separate from raw conversation memory.
