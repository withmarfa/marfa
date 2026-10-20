/**
 * How long a device code lasts, in minutes. The device authorization grant
 * issues codes for this long, and the page where a person types one says so.
 */
export const DEVICE_CODE_LIFETIME_MINUTES = 10;

/** The lifetime in the form the device authorization grant takes. */
export const DEVICE_CODE_LIFETIME =
  `${DEVICE_CODE_LIFETIME_MINUTES.toString()}m` as `${number}m`;
