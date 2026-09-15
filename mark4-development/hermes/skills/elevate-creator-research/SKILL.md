---
name: elevate-creator-research
description: Discover and qualify creators for Elevate OS without inventing unavailable metrics.
---

# Elevate creator research

Use Hermes web/browser capabilities to adapt the discovery strategy dynamically. The Mark 4 creator registry is the authoritative state for dedupe, qualification and measurable targets.

Before fresh discovery:
1. Call `ultron_creator_registry_status` with the numerical target if one exists.
2. Reuse matching saved candidates through `ultron_creator_registry_search`.
3. Search public/authorized sources using niche, location and creator-format variations rather than repeating one query.

When saving a creator:
- canonicalize by platform + handle through `ultron_creator_registry_upsert`;
- set `evidence.profileObserved=true` only after the actual profile was inspected;
- never invent follower count or average views;
- only send `followerCount` or `avgViews` when they were visibly observed and set `evidence.metricsObserved=true`;
- record the observation source/time in evidence when useful;
- qualify based on the user's actual criteria, not generic popularity.

India is the default market for Elevate OS creator research unless Arya requests another geography.
Research is reversible and can run autonomously. External outreach remains approval-gated.
