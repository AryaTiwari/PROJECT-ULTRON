'use strict';

// Dedicated controller for LinkedIn URL backfilling.
// It shares deterministic sheet targeting/schema inspection with the universal
// subsystem, but its execution path is isolated and never enters Apollo POC
// enrichment, paid approval, or the universal enrichment operator.

const sheets = require('./google-sheets-operator');
const universalSheetController = require('./universal-spreadsheet-domain-controller');
const linkEnricher = require('./linkedin-link-sheet-enricher');
const runtimeBuild = require('./runtime-build');

function response(ok, body, extra = {}) {
  const stamped = `${String(body || '').trim()}\\n\\n[linkedin-sheet-links · build ${String(runtimeBuild.revision || '').slice(0, 8) || 'unknown'} · src ${runtimeBuild.fingerprint}]`;
  return {
    ok,
    response: stamped,
    text: stamped,
    model: 'mark3-linkedin-link-enricher',
    provider: 'fastmcp-linkedin+google-sheets',
    taskType: 'linkedin-sheet-link-enrichment',
    mode: 'isolated-operator',
    toolRounds: 0,
    runtimeBuildId: runtimeBuild.id,
    runtimeRevision: runtimeBuild.revision,
    runtimeSourceFingerprint: runtimeBuild.fingerprint,
    apolloCalled: false,
    ...extra,
  };
}

async function handle(message, context = {}) {
  const original = String(context.originalMessage || message || '');
  const sheetUrl = sheets.extractSheetUrl(original) || sheets.extractSheetUrl(message);
  if (!sheetUrl) {
    return response(false,
      'LinkedIn link enrichment stopped safely: no full Google Sheets URL could be resolved. Nothing was edited.',
      {
        error: 'LINKEDIN_LINK_SHEET_URL_REQUIRED',
        errorSubsystem: 'TARGETING',
        errorType: 'CONFIG',
      });
  }

  const requestedSheetName = universalSheetController.parseSheetName(original);
  const rowLimit = universalSheetController.configuredRowLimit(original);
  const companyTask = /\b(?:fill|enrich|find|complete|add|populate|lookup)\b[\s\S]{0,80}\bcompany\b[\s\S]{0,60}\blinkedin\b/i.test(original);
  const personTask = /\b(?:fill|enrich|find|complete|add|populate|lookup)\b[\s\S]{0,80}\b(?:poc|person|contact)\b[\s\S]{0,60}\blinkedin\b/i.test(original);
  const companyOnly = companyTask && !personTask;
  let inspection;

  try {
    inspection = await universalSheetController.inspect(sheetUrl, requestedSheetName, rowLimit, {
      explicitNameAuthoritative: Boolean(requestedSheetName),
      sourceText: original,
      schema: {},
    });
  } catch (error) {
    return response(false,
      `LinkedIn link enrichment stopped safely during sheet inspection: ${String(error?.message || error)} Nothing was edited.`,
      {
        error: error?.code || 'LINKEDIN_LINK_SHEET_INSPECTION_FAILED',
        errorSubsystem: error?.subsystem || 'GOOGLE_SHEETS',
        errorType: error?.errorType || 'API',
        sheetName: error?.sheetName || requestedSheetName || null,
        spreadsheetUrl: sheetUrl,
      });
  }

  const source = {
    spreadsheetId: inspection.spreadsheetId,
    spreadsheetTitle: inspection.spreadsheetTitle,
    sheetName: inspection.sheetName,
    sheetId: inspection.sheetId,
    rows: inspection.rows.map((row) => row.slice()),
    schema: inspection.analysis?.schema,
  };

  if (!source.schema) {
    return response(false,
      'LinkedIn link enrichment stopped safely: deterministic spreadsheet schema was unavailable. Nothing was edited.',
      {
        error: 'LINKEDIN_LINK_SCHEMA_UNAVAILABLE',
        errorSubsystem: 'SCHEMA',
        errorType: 'SCHEMA',
        sheetName: inspection.sheetName,
      });
  }

  try {
    const result = await linkEnricher.run(source, {
      rowLimit,
      companyOnly,
      sheetsApi: context.sheetsApi,
      linkedinMcp: context.linkedinMcp,
    });

    if (!result.activated) {
      return response(true,
        `LinkedIn link enrichment checked worksheet "${inspection.sheetName}" and found no eligible gaps. A row must contain a company or POC name while its corresponding LinkedIn link is blank. No LinkedIn provider calls and no writes were made.`,
        {
          sheetName: inspection.sheetName,
          spreadsheetUrl: sheetUrl,
          activated: false,
          noOp: true,
          stats: result.stats,
          plan: result.plan,
      });
    }

    const unresolvedCompanies = result.stats.companyUnresolvedRows?.length || 0;
    const unresolvedPeople = result.stats.personUnresolvedRows?.length || 0;
    if (unresolvedCompanies || unresolvedPeople) {
      const filled = `${result.stats.companyLinksFilled} company LinkedIn link${result.stats.companyLinksFilled === 1 ? '' : 's'} and ${result.stats.personLinksFilled} POC LinkedIn link${result.stats.personLinksFilled === 1 ? '' : 's'}`;
      const unresolved = [
        unresolvedCompanies ? `${unresolvedCompanies} company row${unresolvedCompanies === 1 ? '' : 's'}` : '',
        unresolvedPeople ? `${unresolvedPeople} POC row${unresolvedPeople === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' and ');
      const unresolvedCount = unresolvedCompanies + unresolvedPeople;
      const providerStop = result.stats.providerStop;
      const detail = providerStop?.message
        ? ` The provider stopped the lookup: ${providerStop.message}`
        : '';
      const blockedBeforeSend = Number(result.stats.linkedinProviderCallsBlocked || 0);
      const unverifiedWrites = Number(result.stats.writeVerificationFailures || 0);
      const writeVerificationSummary = unverifiedWrites > 0
        ? ` Google Sheets did not confirm ${unverifiedWrites} attempted cell write${unverifiedWrites === 1 ? '' : 's'} when Mark 3 read the target cells back.`
        : '';
      const lookupSummary = Number(result.stats.linkedinProviderCalls || 0) > 0
        ? ` This run completed ${Number(result.stats.linkedinProviderCallsSucceeded || 0)} of ${Number(result.stats.linkedinProviderCalls || 0)} LinkedIn tool calls; it resolved ${Number(result.stats.companyJobDetailLinks || 0)} company links directly from job details and found ${Number(result.stats.companySearchRecords || 0)} company-search records (${Number(result.stats.companyExactSearchCandidates || 0)} exact-name candidates, ${Number(result.stats.companyCompatibleSearchMatches || 0)} unique strong name matches, including ${Number(result.stats.companyRankedExactSearchMatches || 0)} top-ranked exact-name matches). Technical retries: ${Number(result.stats.companyTechnicalRetries || 0)}. Ambiguous searches: ${Number(result.stats.companyAmbiguousExactSearches || 0)} exact-name and ${Number(result.stats.companyAmbiguousSearches || 0)} similar-name.`
        : blockedBeforeSend > 0
          ? ` No LinkedIn request was sent: ${blockedBeforeSend} request${blockedBeforeSend === 1 ? ' was' : 's were'} blocked by the local account safety limit before reaching LinkedIn.`
          : '';
      const nextEligibleAt = providerStop?.nextEligibleAt && Number.isFinite(Date.parse(providerStop.nextEligibleAt))
        ? ` The next safe retry time is ${new Date(providerStop.nextEligibleAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', timeZoneName: 'short' })}.`
        : '';
      const nextStep = providerStop?.code && /(?:BURST|HOURLY|DAILY)_CAP|COOLDOWN_ACTIVE/.test(providerStop.code)
        ? ` Wait for the LinkedIn safety window to reset, then rerun the same request; verified links already written will be skipped.${nextEligibleAt}`
        : '';
      return response(true,
        `LinkedIn link enrichment is incomplete on worksheet "${inspection.sheetName}". Filled ${filled}; ${unresolved} ${unresolvedCount === 1 ? 'remains' : 'remain'} unverified. No guessed URLs were written.${writeVerificationSummary}${lookupSummary}${detail}${nextStep}`,
        {
          partial: true,
          complete: false,
          errorCode: 'LINKEDIN_LINKS_UNRESOLVED',
          providerStop,
          errorSubsystem: 'LINKEDIN',
          errorType: 'PARTIAL',
          sheetName: inspection.sheetName,
          spreadsheetUrl: sheetUrl,
          activated: true,
          stats: result.stats,
          plan: result.plan,
          writes: result.writes,
          apolloCalls: 0,
        });
    }

    return response(true,
      `LinkedIn link enrichment completed on worksheet "${inspection.sheetName}". Filled ${result.stats.companyLinksFilled} company LinkedIn link${result.stats.companyLinksFilled === 1 ? '' : 's'} and ${result.stats.personLinksFilled} POC LinkedIn link${result.stats.personLinksFilled === 1 ? '' : 's'}. Existing non-blank links were preserved.`,
      {
        sheetName: inspection.sheetName,
        spreadsheetUrl: sheetUrl,
        activated: true,
        stats: result.stats,
        plan: result.plan,
        writes: result.writes,
        apolloCalls: 0,
      });
  } catch (error) {
    return response(false,
      `LinkedIn link enrichment stopped safely: ${String(error?.message || error)} Existing non-blank LinkedIn cells were never targeted for overwrite.`,
      {
        error: error?.code || 'LINKEDIN_LINK_ENRICHER_FAILED',
        errorSubsystem: error?.subsystem || 'LINKEDIN',
        errorType: error?.errorType || 'API',
        sheetName: inspection.sheetName,
        spreadsheetUrl: sheetUrl,
      });
  }
}

module.exports = { handle };
