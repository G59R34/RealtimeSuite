import { useEffect, useRef, useState } from 'react';
import {
  createOrganizationClockInLocation,
  deleteOrganizationClockInLocation,
  fetchOrganizationClockInLocations,
  updateOrganizationClockInLocation
} from '../lib/api';
import type { OrganizationClockInLocationRow } from '../types';

type ClockInLocationsSettingsProps = {
  organizationId: string | null;
  busy: boolean;
};

type LeafletApi = {
  map: (element: HTMLElement) => {
    setView: (coords: [number, number], zoom: number) => unknown;
    on: (eventName: string, handler: (event: { latlng?: { lat: number; lng: number } }) => void) => void;
    remove: () => void;
    eachLayer: (fn: (layer: { _url?: string; remove?: () => void }) => void) => void;
  };
  tileLayer: (urlTemplate: string, options: Record<string, unknown>) => {
    addTo: (map: unknown) => void;
  };
  marker: (coords: [number, number]) => {
    addTo: (map: unknown) => {
      on: (eventName: string, handler: () => void) => void;
      bindPopup: (html: string) => void;
    };
  };
  circle: (coords: [number, number], options: Record<string, unknown>) => {
    addTo: (map: unknown) => unknown;
  };
};

declare global {
  interface Window {
    L?: LeafletApi;
  }
}

const DEFAULT_LAT = 39.7392;
const DEFAULT_LNG = -104.9903;
const DEFAULT_RADIUS_METERS = 150;

function toFixedCoordinate(value: number): string {
  return value.toFixed(6);
}

async function ensureLeafletLoaded(): Promise<LeafletApi> {
  if (window.L) return window.L;

  const cssId = 'leaflet-runtime-css';
  if (!document.getElementById(cssId)) {
    const link = document.createElement('link');
    link.id = cssId;
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
  }

  await new Promise<void>((resolve, reject) => {
    const existing = document.getElementById('leaflet-runtime-js') as HTMLScriptElement | null;
    if (existing) {
      if (window.L) {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load map library.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.id = 'leaflet-runtime-js';
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load map library.'));
    document.body.appendChild(script);
  });

  if (!window.L) throw new Error('Map library is unavailable.');
  return window.L;
}

export function ClockInLocationsSettings({ organizationId, busy }: ClockInLocationsSettingsProps) {
  const [locations, setLocations] = useState<OrganizationClockInLocationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [name, setName] = useState('Main Site');
  const [latitude, setLatitude] = useState(toFixedCoordinate(DEFAULT_LAT));
  const [longitude, setLongitude] = useState(toFixedCoordinate(DEFAULT_LNG));
  const [radiusMeters, setRadiusMeters] = useState(String(DEFAULT_RADIUS_METERS));
  const [isActive, setIsActive] = useState(true);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<ReturnType<LeafletApi['map']> | null>(null);

  const disabled = busy || loading || saving;

  useEffect(() => {
    if (!organizationId) {
      setLocations([]);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setErrorMessage(null);

    fetchOrganizationClockInLocations()
      .then((rows) => {
        if (!isMounted) return;
        setLocations(rows);
      })
      .catch((error) => {
        if (!isMounted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load clock-in locations.');
      })
      .finally(() => {
        if (!isMounted) return;
        setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;

    async function bootMap() {
      if (!mapContainerRef.current || mapInstanceRef.current) return;

      try {
        const L = await ensureLeafletLoaded();
        if (cancelled || !mapContainerRef.current) return;

        const map = L.map(mapContainerRef.current);
        map.setView([DEFAULT_LAT, DEFAULT_LNG], 11);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);

        map.on('click', (event) => {
          if (!event.latlng) return;
          setLatitude(toFixedCoordinate(event.latlng.lat));
          setLongitude(toFixedCoordinate(event.latlng.lng));
        });

        mapInstanceRef.current = map;
      } catch (error) {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : 'Failed to initialize map.');
      }
    }

    void bootMap();

    return () => {
      cancelled = true;
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const L = window.L;
    if (!map || !L) return;

    map.eachLayer((layer) => {
      if ((layer as { _url?: string })._url) return;
      if (typeof layer.remove === 'function') {
        layer.remove();
      }
    });

    let centerLat = Number(latitude);
    let centerLng = Number(longitude);

    for (const location of locations) {
      L.circle([location.latitude, location.longitude], {
        radius: location.radius_meters,
        color: location.is_active ? '#1d4ed8' : '#9ca3af',
        fillColor: location.is_active ? '#3b82f6' : '#d1d5db',
        fillOpacity: 0.2,
        weight: 2
      }).addTo(map);

      const marker = L.marker([location.latitude, location.longitude]).addTo(map);
      marker.bindPopup(`<strong>${location.name}</strong><br/>Radius: ${Math.round(location.radius_meters)}m`);
      marker.on('click', () => {
        setSelectedLocationId(location.id);
        setName(location.name);
        setLatitude(toFixedCoordinate(location.latitude));
        setLongitude(toFixedCoordinate(location.longitude));
        setRadiusMeters(String(Math.round(location.radius_meters)));
        setIsActive(location.is_active);
      });

      if (selectedLocationId === location.id) {
        centerLat = location.latitude;
        centerLng = location.longitude;
      }
    }

    if (Number.isFinite(centerLat) && Number.isFinite(centerLng)) {
      map.setView([centerLat, centerLng], 13);
    }
  }, [locations, selectedLocationId, latitude, longitude]);

  function resetDraft() {
    setSelectedLocationId(null);
    setName('Main Site');
    setLatitude(toFixedCoordinate(DEFAULT_LAT));
    setLongitude(toFixedCoordinate(DEFAULT_LNG));
    setRadiusMeters(String(DEFAULT_RADIUS_METERS));
    setIsActive(true);
  }

  async function handleSave() {
    setStatusMessage(null);
    setErrorMessage(null);

    if (!organizationId) {
      setErrorMessage('Organization context is required.');
      return;
    }

    const latValue = Number(latitude);
    const lngValue = Number(longitude);
    const radiusValue = Math.max(10, Number(radiusMeters) || DEFAULT_RADIUS_METERS);

    if (!Number.isFinite(latValue) || !Number.isFinite(lngValue)) {
      setErrorMessage('Latitude and longitude are required.');
      return;
    }

    if (!name.trim()) {
      setErrorMessage('Location name is required.');
      return;
    }

    setSaving(true);
    try {
      if (selectedLocationId) {
        const updated = await updateOrganizationClockInLocation({
          id: selectedLocationId,
          name: name.trim(),
          latitude: latValue,
          longitude: lngValue,
          radiusMeters: radiusValue,
          isActive
        });
        setLocations((current) => current.map((row) => (row.id === updated.id ? updated : row)));
        setStatusMessage('Clock-in location updated.');
      } else {
        const created = await createOrganizationClockInLocation({
          organizationId,
          name: name.trim(),
          latitude: latValue,
          longitude: lngValue,
          radiusMeters: radiusValue,
          isActive
        });
        setLocations((current) => [created, ...current]);
        setSelectedLocationId(created.id);
        setStatusMessage('Clock-in location created.');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save clock-in location.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedLocationId) return;

    setStatusMessage(null);
    setErrorMessage(null);
    setSaving(true);

    try {
      await deleteOrganizationClockInLocation(selectedLocationId);
      setLocations((current) => current.filter((row) => row.id !== selectedLocationId));
      resetDraft();
      setStatusMessage('Clock-in location deleted.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to delete clock-in location.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="org-settings-geofence">
      <div className="org-settings-geofence-head">
        <h3>Clock-In Locations</h3>
        <p>Click the map to set coordinates, then save an allowed clock-in radius.</p>
      </div>

      <div className="org-settings-geofence-map" ref={mapContainerRef} />

      <div className="org-settings-geofence-form">
        <label>
          Location Name
          <input type="text" value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} />
        </label>

        <label>
          Latitude
          <input type="number" step="0.000001" value={latitude} onChange={(event) => setLatitude(event.target.value)} disabled={disabled} />
        </label>

        <label>
          Longitude
          <input type="number" step="0.000001" value={longitude} onChange={(event) => setLongitude(event.target.value)} disabled={disabled} />
        </label>

        <label>
          Radius (meters)
          <input type="number" min={10} max={10000} value={radiusMeters} onChange={(event) => setRadiusMeters(event.target.value)} disabled={disabled} />
        </label>

        <label className="org-settings-checkbox">
          <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} disabled={disabled} />
          Active
        </label>
      </div>

      <div className="org-settings-geofence-actions">
        <button type="button" onClick={resetDraft} disabled={disabled}>
          New Location
        </button>
        <button type="button" onClick={() => void handleSave()} disabled={disabled}>
          {selectedLocationId ? 'Update Location' : 'Save Location'}
        </button>
        <button type="button" onClick={() => void handleDelete()} disabled={disabled || !selectedLocationId}>
          Delete Location
        </button>
      </div>

      {statusMessage ? <div className="org-settings-success">{statusMessage}</div> : null}
      {errorMessage ? <div className="org-settings-error">{errorMessage}</div> : null}

      <div className="org-settings-geofence-list">
        {locations.length === 0 ? (
          <p className="empty-state">No clock-in locations configured yet.</p>
        ) : (
          <ul>
            {locations.map((location) => (
              <li key={location.id}>
                <button
                  type="button"
                  className={selectedLocationId === location.id ? 'active' : ''}
                  onClick={() => {
                    setSelectedLocationId(location.id);
                    setName(location.name);
                    setLatitude(toFixedCoordinate(location.latitude));
                    setLongitude(toFixedCoordinate(location.longitude));
                    setRadiusMeters(String(Math.round(location.radius_meters)));
                    setIsActive(location.is_active);
                  }}
                  disabled={disabled}
                >
                  <strong>{location.name}</strong>
                  <span>{Math.round(location.radius_meters)}m radius</span>
                  <span>{location.is_active ? 'Active' : 'Inactive'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
