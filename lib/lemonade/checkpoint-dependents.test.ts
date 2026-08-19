import {test, expect} from 'bun:test';
import {
  checkpointDependents,
  dependentsForFile,
} from '@/lib/lemonade/checkpoint-dependents';
import type {
  Checkpoint,
  LemonadeComponent,
  OmniCollection,
} from '@/lib/lemonade/lemonade-types';

const comp = (name: string, checkpoints: Checkpoint[]): LemonadeComponent => ({
  name,
  recipe: 'sd-cpp',
  modality: 'image',
  suggested: false,
  labels: [],
  sizeGb: 1,
  downloadable: true,
  checkpoints,
});

// The multi-checkpoint shape: weights, a text encoder from a second repo, and
// a whole-repo VAE. Deleting any of the three breaks the catalog entry.
const image = comp('Image-9B', [
  {repoId: 'o/image-GGUF', variant: 'image-q8.gguf'},
  {repoId: 'o/encoder-GGUF', variant: 'encoder-q8.gguf'},
  {repoId: 'o/vae', variant: null},
]);
// A single-checkpoint entry IS its repo — "needed by itself" would be noise.
const lone = comp('Lone', [{repoId: 'o/lone-GGUF', variant: 'Q4_0'}]);

test('checkpointDependents indexes only multi-checkpoint entries', () => {
  const deps = checkpointDependents({
    extraModels: [image, lone],
    collections: [],
  });
  expect([...deps.keys()].sort()).toEqual([
    'o/encoder-GGUF',
    'o/image-GGUF',
    'o/vae',
  ]);
});

test('dependentsForFile names the entries that need exactly this file', () => {
  const deps = checkpointDependents({extraModels: [image], collections: []});
  expect(
    dependentsForFile(deps, 'o/encoder-GGUF', 'encoder-q8.gguf', 'Q8_0'),
  ).toEqual(['Image-9B']);
  // Another quant of the same repo is not the dependency.
  expect(
    dependentsForFile(deps, 'o/encoder-GGUF', 'encoder-q4.gguf', 'Q4_0'),
  ).toEqual([]);
  // Same basename under a different model name matches nothing.
  expect(
    dependentsForFile(deps, 'o/other', 'encoder-q8.gguf', 'Q8_0'),
  ).toEqual([]);
});

test('a whole-repo checkpoint claims every file of that repo', () => {
  const deps = checkpointDependents({extraModels: [image], collections: []});
  expect(
    dependentsForFile(deps, 'o/vae', 'anything.safetensors', 'unknown'),
  ).toEqual(['Image-9B']);
});

test('collection members contribute their checkpoints too', () => {
  const col: OmniCollection = {
    name: 'Omni',
    suggested: false,
    sizeGb: 0,
    labels: [],
    components: [image],
  };
  const deps = checkpointDependents({extraModels: [], collections: [col]});
  expect(
    dependentsForFile(deps, 'o/image-GGUF', 'image-q8.gguf', 'Q8_0'),
  ).toEqual(['Image-9B']);
});
