'use strict';

const DEFAULT_STEPS_KM = [0, 10, 25, 50, 75, 100];
const NEARBY = {
  pune: [{ location: 'Pimpri-Chinchwad', distanceKm: 18 }, { location: 'Chakan', distanceKm: 30 }, { location: 'Talegaon Dabhade', distanceKm: 35 }, { location: 'Mumbai', distanceKm: 150 }],
  mumbai: [{ location: 'Navi Mumbai', distanceKm: 22 }, { location: 'Thane', distanceKm: 25 }, { location: 'Kalyan', distanceKm: 45 }, { location: 'Pune', distanceKm: 150 }],
  bengaluru: [{ location: 'Whitefield', distanceKm: 20 }, { location: 'Electronic City', distanceKm: 22 }, { location: 'Bengaluru Metropolitan Area', distanceKm: 35 }, { location: 'Mysuru', distanceKm: 145 }],
  kolkata: [{ location: 'Salt Lake City', distanceKm: 12 }, { location: 'New Town', distanceKm: 18 }, { location: 'Kolkata Metropolitan Area', distanceKm: 35 }],
  hyderabad: [{ location: 'HITEC City', distanceKm: 15 }, { location: 'Secunderabad', distanceKm: 16 }, { location: 'Hyderabad Metropolitan Area', distanceKm: 35 }],
  chennai: [{ location: 'Chennai Metropolitan Area', distanceKm: 30 }, { location: 'Sriperumbudur', distanceKm: 45 }],
};

function stages(root, expansion = null) {
  const base = String(root || '').trim();
  if (!base) return [];
  if (!expansion) return [{ location: base, radiusKm: 0, expansionLevel: 0, expanded: false }];
  const maximum = Math.max(0, Number(expansion.maximumRadiusKm ?? expansion.requestedRadiusKm ?? 0));
  const initial = Math.max(0, Number(expansion.initialRadiusKm ?? expansion.requestedRadiusKm ?? 0));
  const permittedSteps = (Array.isArray(expansion.stepsKm) && expansion.stepsKm.length ? expansion.stepsKm : DEFAULT_STEPS_KM)
    .map(Number).filter((step) => Number.isFinite(step) && step >= 0 && step <= maximum);
  if (!permittedSteps.includes(initial) && initial <= maximum) permittedSteps.push(initial);
  permittedSteps.sort((a, b) => a - b);
  const out = [{ location: base, radiusKm: initial, expansionLevel: 0, expanded: false }];
  const nearby = NEARBY[base.toLowerCase()] || [];
  for (const item of nearby) {
    if (item.distanceKm > maximum) continue;
    const stageRadius = permittedSteps.find((step) => step >= item.distanceKm);
    if (stageRadius == null) continue;
    out.push({ location: item.location, radiusKm: stageRadius, expansionLevel: permittedSteps.indexOf(stageRadius), expanded: true, rootLocation: base });
  }
  return out;
}

function summarize(searches = [], requested = '') {
  const expanded = searches.filter((item) => item.expanded || Number(item.radiusKm || 0) > 0);
  if (!expanded.length) return null;
  const maximum = Math.max(...expanded.map((item) => Number(item.radiusKm || 0)));
  return { requested: requested || expanded[0].rootLocation || '', currentRadiusKm: maximum, expansionReason: 'target not reached in narrower strategies', searchedLocations: [...new Set(expanded.map((item) => item.location).filter(Boolean))] };
}

module.exports = { DEFAULT_STEPS_KM, NEARBY, stages, summarize };
