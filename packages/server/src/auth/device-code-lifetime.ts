/**
 * How long a device code lasts, in the form the device authorization grant
 * takes. The grant issues codes for this long, and the page where a person
 * types one says so, in minutes.
 */
export const DEVICE_CODE_LIFETIME = "10m";

export const DEVICE_CODE_LIFETIME_MINUTES = Number.parseInt(
  DEVICE_CODE_LIFETIME,
  10,
);
