'use strict';

// Exact worksheet targeting for universal spreadsheet enrichment.
// Explicit tab names and Google Sheets gid fragments are authoritative. The
// engine may compare schema confidence across tabs only when the user supplied
// no worksheet target at all.
//
// When a workbook was supplied through an app/file mention, the resolved URL can
// carry a stale UI-view gid. In that case callers may set explicitNameAuthoritative
// so an explicitly named worksheet beats that incidental gid. Direct user-pasted
// tab URLs should leave that option false and conflicts fail closed.
//
// IMPORTANT: Google metadata is advisory for an explicitly named worksheet.
// Some connector/runtime paths can return incomplete or scoped metadata even
// though an exact A1 Values read for the named tab succeeds. In authoritative
// name mode we therefore synthesize the requested target when metadata is empty
// or omits the name. The downstream exact Values read is the existence check.

function text(value) { return String(value ?? '').trim(); }

function parseGid(value) {
  const match = String(value || '').match(/[?#&]gid=(\d+)/i);
  return match ? Number(match[1]) : null;
}

function tabsFromMetadata(meta = {}) {
  return (meta.sheets || [])
    .map((sheet) => ({
      name: text(sheet?.properties?.title),
      sheetId: Number(sheet?.properties?.sheetId),
      index: Number(sheet?.properties?.index),
    }))
    .filter((tab) => tab.name && Number.isFinite(tab.sheetId));
}

function namedTab(tabs, requestedName) {
  const wanted = text(requestedName);
  if (!wanted) return null;
  const exact = tabs.find((tab) => tab.name === wanted);
  if (exact) return exact;
  const folded = tabs.filter((tab) => tab.name.toLocaleLowerCase() === wanted.toLocaleLowerCase());
  return folded.length === 1 ? folded[0] : null;
}

function targetError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function syntheticNamedTarget(requestedName) {
  return {
    name: text(requestedName),
    sheetId: null,
    index: null,
    synthetic: true,
  };
}

function authoritativeNameResolution(tabs, requestedName, gid, reason) {
  const target = syntheticNamedTarget(requestedName);
  return {
    tabs,
    targets: [target],
    targeted: true,
    targetSource: reason,
    requestedName: text(requestedName),
    requestedGid: gid,
    ignoredViewGid: gid,
    metadataFallback: true,
    target,
  };
}

function resolveTabs(meta, sheetUrl, options = {}) {
  const tabs = tabsFromMetadata(meta);
  const requestedName = text(options.sheetName);
  const gid = parseGid(sheetUrl);
  const explicitNameAuthoritative = Boolean(options.explicitNameAuthoritative && requestedName);

  // In explicit-name mode metadata is not allowed to veto a real worksheet.
  // The exact A1 Values read performed immediately downstream proves whether
  // the named tab actually exists and is readable.
  if (!tabs.length) {
    if (explicitNameAuthoritative) {
      return authoritativeNameResolution(tabs, requestedName, gid, 'explicit-name-metadata-empty-bypass');
    }
    throw targetError('UNIVERSAL_SHEET_TAB_NOT_FOUND', 'Spreadsheet has no readable tabs.');
  }

  const byName = requestedName ? namedTab(tabs, requestedName) : null;
  const byGid = gid != null ? tabs.find((tab) => tab.sheetId === gid) || null : null;

  if (requestedName && !byName) {
    if (explicitNameAuthoritative) {
      return authoritativeNameResolution(tabs, requestedName, gid, 'explicit-name-metadata-miss-bypass');
    }
    throw targetError('UNIVERSAL_SHEET_TAB_NOT_FOUND', `Google Sheet tab not found: ${requestedName}`, {
      requestedSheetName: requestedName,
      availableTabs: tabs.map((tab) => tab.name),
    });
  }
  if (gid != null && !byGid && !explicitNameAuthoritative) {
    throw targetError('UNIVERSAL_SHEET_GID_NOT_FOUND', `Google Sheet tab for gid=${gid} was not found.`, {
      requestedGid: gid,
      availableTabs: tabs.map((tab) => ({ name: tab.name, sheetId: tab.sheetId })),
    });
  }
  if (byName && byGid && byName.sheetId !== byGid.sheetId && !explicitNameAuthoritative) {
    throw targetError(
      'UNIVERSAL_SHEET_TARGET_CONFLICT',
      `Requested tab "${byName.name}" conflicts with the Google Sheets URL target "${byGid.name}" (gid=${gid}). Nothing should be edited until the target is unambiguous.`,
      { requestedSheetName: byName.name, requestedGid: gid, gidSheetName: byGid.name }
    );
  }

  const target = byName || byGid || null;
  const nameOverrodeGid = Boolean(explicitNameAuthoritative && byName && byGid && byName.sheetId !== byGid.sheetId);
  return {
    tabs,
    targets: target ? [target] : tabs,
    targeted: Boolean(target),
    targetSource: nameOverrodeGid
      ? 'explicit-name-over-mention-gid'
      : byName && byGid
        ? 'name+gid'
        : byName
          ? 'name'
          : byGid
            ? 'gid'
            : 'none',
    requestedName: requestedName || '',
    requestedGid: gid,
    ignoredViewGid: nameOverrodeGid ? gid : null,
    metadataFallback: false,
    target,
  };
}

module.exports = {
  text,
  parseGid,
  tabsFromMetadata,
  namedTab,
  syntheticNamedTarget,
  authoritativeNameResolution,
  resolveTabs,
};
