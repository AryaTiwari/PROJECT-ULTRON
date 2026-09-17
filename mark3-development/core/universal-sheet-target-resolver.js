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

function resolveTabs(meta, sheetUrl, options = {}) {
  const tabs = tabsFromMetadata(meta);
  if (!tabs.length) throw targetError('UNIVERSAL_SHEET_TAB_NOT_FOUND', 'Spreadsheet has no readable tabs.');

  const requestedName = text(options.sheetName);
  const gid = parseGid(sheetUrl);
  const byName = requestedName ? namedTab(tabs, requestedName) : null;
  const byGid = gid != null ? tabs.find((tab) => tab.sheetId === gid) || null : null;
  const explicitNameAuthoritative = Boolean(options.explicitNameAuthoritative && requestedName);

  if (requestedName && !byName) {
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
    target,
  };
}

module.exports = { text, parseGid, tabsFromMetadata, namedTab, resolveTabs };
