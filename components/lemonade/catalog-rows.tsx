'use client';

import type {ReactNode} from 'react';
import {HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Badge} from '@astryxdesign/core/Badge';
import type {
  LemonadeComponent,
  LemonadeDownloadInfo,
  LemonadeModel,
} from '@/lib/lemonade/lemonade';
import {formatGb, uniq} from '@/lib/lemonade/lemonade-catalog';
import {sortLabelsForDisplay} from '@/lib/lemonade/lemonade-labels';
import {ModelLabelIcon} from '@/components/lemonade/model-label-icon';
import {
  IncompleteMarker,
  LemonadeCacheMarker,
  StatusMarker,
} from '@/components/lemonade/markers';

// The end-of-row content shared by a flat model and a collection's
// downloadable member: download status, suggested badge, capability icons,
// and size.
export function modelEndContent(
  model: LemonadeModel,
  info: LemonadeDownloadInfo | undefined,
  inCache: boolean,
  showSuggestedToken: boolean,
) {
  return (
    <HStack gap={1} vAlign="center">
      <StatusMarker info={info} />
      <LemonadeCacheMarker present={inCache} />
      {showSuggestedToken && model.suggested && (
        <Badge label="suggested" variant="green" />
      )}
      {model.labels.length > 0 && (
        <HStack gap={1} vAlign="center">
          {sortLabelsForDisplay(model.labels).map((l) => (
            <ModelLabelIcon key={l} label={l} />
          ))}
        </HStack>
      )}
      <Text type="supporting">{formatGb(model.sizeGb)}</Text>
    </HStack>
  );
}

// A collection member's secondary line: the repo(s) its checkpoints pull from.
export function componentSecondary(component: LemonadeComponent): string {
  const repos = uniq(component.checkpoints.map((c) => c.repoId));
  if (repos.length === 0) return component.modality;
  if (repos.length === 1) return repos[0];
  return `${repos[0]} +${repos.length - 1}`;
}

// A component's end-of-row content: a download-status marker (when the weight
// scan can track it), suggested badge, its capability icons — or its modality,
// for label-less collection members — and its size. `statusDetail` is the
// per-checkpoint breakdown shown in the status marker's hovercard, and the
// cache marker dims when Lemonade's cache holds only part of the entry —
// which, for a multi-checkpoint model, means Lemonade doesn't list it at all.
export function componentEndContent(
  component: LemonadeComponent,
  info: LemonadeDownloadInfo,
  cachePresence: 'none' | 'partial' | 'complete',
  incomplete: boolean,
  showSuggestedToken: boolean,
  statusDetail?: ReactNode,
) {
  return (
    <HStack gap={1} vAlign="center">
      <StatusMarker info={info} content={statusDetail} />
      <LemonadeCacheMarker
        present={cachePresence !== 'none'}
        muted={cachePresence === 'partial'}
      />
      <IncompleteMarker incomplete={incomplete} />
      {showSuggestedToken && component.suggested && (
        <Badge label="suggested" variant="green" />
      )}
      {component.labels.length > 0 ? (
        <HStack gap={1} vAlign="center">
          {sortLabelsForDisplay(component.labels).map((l) => (
            <ModelLabelIcon key={l} label={l} />
          ))}
        </HStack>
      ) : (
        <Badge label={component.modality} variant="neutral" />
      )}
      <Text type="supporting">{formatGb(component.sizeGb)}</Text>
    </HStack>
  );
}
