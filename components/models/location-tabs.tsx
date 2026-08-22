'use client';

import {TabList, Tab} from '@astryxdesign/core/TabList';
import {StatusDot} from '@astryxdesign/core/StatusDot';

export interface LocationTab {
  id: string;
  label: string;
  isLocal: boolean;
  down?: boolean;
}

// The All / per-peer / Cold Storage tab row that drives the active location.
// Cold Storage is this machine's archive, so the tab exists only where one is
// configured.
export function LocationTabs({
  locations,
  hasColdStorage,
  activeLocation,
  onLocationChange,
}: {
  locations: LocationTab[];
  hasColdStorage: boolean;
  activeLocation: string;
  onLocationChange: (id: string) => void;
}) {
  return (
    <TabList value={activeLocation} onChange={onLocationChange}>
      <Tab value="all" label="All" />
      {locations.map((loc) => (
        <Tab
          key={loc.id}
          value={loc.id}
          label={loc.isLocal ? `${loc.label} (local)` : loc.label}
          endContent={
            loc.down ? (
              <StatusDot
                variant="error"
                label="Unreachable"
                tooltip="Peer is down or unreachable"
              />
            ) : undefined
          }
        />
      ))}
      {hasColdStorage && <Tab value="cold-storage" label="Cold Storage" />}
    </TabList>
  );
}
