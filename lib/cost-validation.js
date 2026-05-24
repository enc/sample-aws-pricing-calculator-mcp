// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function extractTotals(estimateData) {
  const monthly = toNumber(estimateData?.totalCost?.monthly);
  const upfront = toNumber(estimateData?.totalCost?.upfront) ?? 0;
  return { monthly, upfront };
}

function calculateArr(monthly) {
  return monthly == null ? null : roundMoney(monthly * 12);
}

function calculateDelta(expectedArr, actualArr) {
  if (actualArr == null) {
    return { delta: null, deltaPercent: null };
  }
  const delta = roundMoney(actualArr - expectedArr);
  const deltaPercent = expectedArr === 0
    ? (actualArr === 0 ? 0 : null)
    : roundMoney((delta / expectedArr) * 100);
  return { delta, deltaPercent };
}

function flattenServiceCosts(estimateData) {
  const drivers = [];

  const visitServices = (services, groupName = null) => {
    for (const [, svc] of Object.entries(services || {})) {
      const monthly = toNumber(svc.serviceCost?.monthly);
      const upfront = toNumber(svc.serviceCost?.upfront) ?? 0;
      if (monthly == null && upfront === 0) continue;
      drivers.push({
        service: svc.serviceName || svc.serviceCode || 'Unknown service',
        description: svc.description || null,
        group: groupName,
        monthly: monthly ?? 0,
        arr: calculateArr(monthly ?? 0),
        upfront,
      });
    }
  };

  visitServices(estimateData?.services);
  for (const [, group] of Object.entries(estimateData?.groups || {})) {
    visitServices(group.services, group.name || null);
  }

  return drivers.sort((a, b) => b.monthly - a.monthly);
}

function buildWarnings({ expectedArr, actualArr, deltaPercent, tolerancePercent, monthly }) {
  const warnings = [];
  if (monthly == null) {
    warnings.push('AWS estimate readback did not include totalCost.monthly, so ARR could not be validated.');
    return warnings;
  }
  if (deltaPercent == null) {
    warnings.push('Delta percent could not be calculated because expected ARR is 0 and actual ARR is non-zero.');
    return warnings;
  }
  if (Math.abs(deltaPercent) > tolerancePercent) {
    const direction = actualArr > expectedArr ? 'above' : 'below';
    warnings.push(`Actual ARR is ${Math.abs(deltaPercent)}% ${direction} expected ARR.`);
  }
  return warnings;
}

function validateEstimateCost(estimateData, expectedAnnualRecurring, tolerancePercent = 10) {
  const expectedArr = Number(expectedAnnualRecurring);
  const tolerance = Number(tolerancePercent);
  if (!Number.isFinite(expectedArr) || expectedArr < 0) {
    throw new Error('expected_annual_recurring must be a non-negative number.');
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('tolerance_percent must be a non-negative number.');
  }

  const { monthly, upfront } = extractTotals(estimateData);
  const actualArr = calculateArr(monthly);
  const { delta, deltaPercent } = calculateDelta(expectedArr, actualArr);
  const warnings = buildWarnings({
    expectedArr,
    actualArr,
    deltaPercent,
    tolerancePercent: tolerance,
    monthly,
  });
  const passed = monthly != null
    && deltaPercent != null
    && Math.abs(deltaPercent) <= tolerance;

  return {
    passed,
    expected_arr: roundMoney(expectedArr),
    actual_monthly: monthly == null ? null : roundMoney(monthly),
    actual_arr: actualArr,
    upfront_total: roundMoney(upfront),
    delta,
    delta_percent: deltaPercent,
    tolerance_percent: tolerance,
    top_cost_drivers: flattenServiceCosts(estimateData).slice(0, 10),
    warnings,
  };
}

function expectedServicesForVisualCheck(estimateData) {
  return flattenServiceCosts(estimateData)
    .map(driver => ({ name: driver.service }))
    .filter((svc, idx, arr) => arr.findIndex(other => other.name === svc.name) === idx);
}

module.exports = {
  calculateArr,
  calculateDelta,
  extractTotals,
  flattenServiceCosts,
  validateEstimateCost,
  expectedServicesForVisualCheck,
};
