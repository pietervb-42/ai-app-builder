// lib/validate/classes.js
export const ValidationClass = Object.freeze({
  BOOT_FAIL: "BOOT_FAIL",
  HEALTH_FAIL: "HEALTH_FAIL",
  ENDPOINT_FAIL: "ENDPOINT_FAIL",
  SCHEMA_FAIL: "SCHEMA_FAIL",
  UNKNOWN_FAIL: "UNKNOWN_FAIL",
});

export const ExitCode = Object.freeze({
  OK: 0,
  BOOT_FAIL: 10,
  HEALTH_FAIL: 11,
  ENDPOINT_FAIL: 12,
  SCHEMA_FAIL: 13,
  UNKNOWN_FAIL: 1,
});

export function exitCodeForFailureClass(failureClass) {
  switch (failureClass) {
    case null:
    case undefined:
      return ExitCode.OK;
    case ValidationClass.BOOT_FAIL:
      return ExitCode.BOOT_FAIL;
    case ValidationClass.HEALTH_FAIL:
      return ExitCode.HEALTH_FAIL;
    case ValidationClass.ENDPOINT_FAIL:
      return ExitCode.ENDPOINT_FAIL;
    case ValidationClass.SCHEMA_FAIL:
      return ExitCode.SCHEMA_FAIL;
    default:
      return ExitCode.UNKNOWN_FAIL;
  }
}
