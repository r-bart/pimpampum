#!/usr/bin/env node

export function prepareMacosRuntimePackage(dependencies) {
  let primaryError;
  let restorationError;
  let result;

  try {
    try {
      dependencies.prepare();
      const packed = dependencies.pack();
      result = dependencies.install(packed);
    } catch (error) {
      primaryError = error;
    }
  } finally {
    try {
      dependencies.restore();
    } catch (error) {
      restorationError = error;
    }
  }

  if (primaryError !== undefined) {
    if (restorationError !== undefined) {
      throw new AggregateError(
        [primaryError, restorationError],
        'macOS live package preparation failed and its manifest could not be restored',
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (restorationError !== undefined) throw restorationError;
  return result;
}
