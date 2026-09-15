---
name: linkedin-company-research
description: Evidence-first company discovery from LinkedIn hiring data with adaptive search strategy and strict dedupe.
---

# LinkedIn company research
When discovery is scoped to LinkedIn, use authenticated LinkedIn capabilities/browser evidence only for discovery. Apollo is enrichment, not discovery.

1. Read the canonical current master/count before searching.
2. Calculate the true remaining gap.
3. Reuse cached/saved evidence first.
4. Prefer job-first discovery when company keyword search has low recall.
5. Map verified active jobs to unique employers.
6. Verify every hard constraint before accepting a company.
7. Deduplicate by canonical company identity, not job count.
8. If generic queries saturate, adapt title families and specialization terms rather than repeating the same search.
9. Respect account safety, checkpoints, auth walls and rate limits. Never bypass CAPTCHA/checkpoints.
10. Update mission state from authoritative output after each committed batch.

For SAP, useful families can include FICO, MM, SD, ABAP, Basis, HANA, S/4HANA, SuccessFactors and BW when relevant.
