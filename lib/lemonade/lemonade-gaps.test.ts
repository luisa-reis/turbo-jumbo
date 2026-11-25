import {test, expect} from 'bun:test';
import {
  lemonadeEntriesByRepo,
  lemonadeGaps,
} from '@/lib/lemonade/lemonade-gaps';
import type {Model} from '@/lib/models/model-types';
import type {LemonadeComponent} from '@/lib/lemonade/lemonade-types';

const REPO = 'org/Next-GGUF';

// A multi-checkpoint entry like Lemonade's MTP models: the main quant, a draft
// model in a subfolder and a BF16 projector, all from one repo.
const gufo: LemonadeComponent = {
  name: 'Next-Gufo',
  recipe: 'gufo',
  modality: 'chat',
  suggested: true,
  labels: [],
  sizeGb: 115,
  downloadable: true,
  checkpoints: [
    {repoId: REPO, variant: 'UD-Q4_K_XL'},
    {repoId: REPO, variant: 'MTP/mtp-Next-shared-Q8_0.gguf'},
    {repoId: REPO, variant: 'mmproj-BF16.gguf'},
  ],
};

// What the location holds: the main quant's shards and the F16 projector — not
// the BF16 one the entry names, and no draft model.
const held: Model[] = [
  {
    name: REPO,
    files: [
      {
        isSplit: true,
        representativeFilename: 'Next-UD-Q4_K_XL-00001-of-00002.gguf',
        files: [1, 2].map((n) => ({
          path: `${REPO}/UD-Q4_K_XL/Next-UD-Q4_K_XL-0000${n}-of-00002.gguf`,
          size: 1,
        })),
        quant: 'UD-Q4_K_XL',
        totalShards: 2,
        presentShards: 2,
        missingIndices: [],
        totalSize: 2,
      },
      {
        isSplit: false,
        filename: 'mmproj-F16.gguf',
        path: `${REPO}/mmproj-F16.gguf`,
        quant: 'F16',
        size: 1,
        missing: false,
      },
    ],
  } as Model,
];

test('lemonadeGaps names the checkpoints a held entry still lacks', () => {
  const entries = lemonadeEntriesByRepo({extraModels: [gufo]}).get(REPO) ?? [];
  expect(lemonadeGaps(entries, held)).toEqual([
    {
      name: 'Next-Gufo',
      missing: [
        {repoId: REPO, variant: 'MTP/mtp-Next-shared-Q8_0.gguf'},
        {repoId: REPO, variant: 'mmproj-BF16.gguf'},
      ],
    },
  ]);
});

test('lemonadeGaps reports a whole entry with nothing missing', () => {
  const entries = lemonadeEntriesByRepo({
    models: [
      {
        name: 'Next-GGUF',
        repoId: REPO,
        variant: 'UD-Q4_K_XL',
        mmproj: 'mmproj-F16.gguf',
        suggested: false,
        labels: [],
        sizeGb: 1,
      },
    ],
  }).get(REPO)!;
  expect(lemonadeGaps(entries, held)).toEqual([
    {name: 'Next-GGUF', missing: []},
  ]);
});

test('lemonadeGaps leaves out an entry the location holds no part of', () => {
  const entries = lemonadeEntriesByRepo({extraModels: [gufo]}).get(REPO)!;
  expect(lemonadeGaps(entries, [])).toEqual([]);
});
