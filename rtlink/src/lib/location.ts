export interface ClockLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
}

/**
 * Ask the browser for a position when the site verifies clock-in location.
 * Resolves to undefined when permission is denied or the device has no GPS —
 * the LAN site then decides whether clock-in is still allowed.
 */
export function clockLocation(timeoutMs = 9000): Promise<ClockLocation | undefined> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ClockLocation | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(undefined), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        window.clearTimeout(timer);
        finish({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: Math.round(position.coords.accuracy)
        });
      },
      () => {
        window.clearTimeout(timer);
        finish(undefined);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
    );
  });
}
