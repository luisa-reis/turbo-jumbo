// A repo's model card. The file list says what a repo contains; only the card
// says what any of it is for — which quantization to pick for how much RAM,
// and which files pair with which. antirez/deepseek-v4-gguf spells out that its
// MTP head is "optional, not standalone" and needs a specific loader, and none
// of that is inferable from thirteen filenames.

import {logger} from '@/lib/util/logger';

const HEADERS = {'User-Agent': 'tj/1.0'};

/**
 * Cards are prose and rarely large, but nothing stops a repo shipping a
 * novel; past this the picker would be scrolling a book rather than showing a
 * card, so it is cut and says so.
 */
const MAX_CHARS = 60_000;

export interface RepoCard {
  /** The card's markdown, frontmatter removed and possibly truncated. */
  markdown: string;
  /** Whether it was cut at MAX_CHARS. */
  truncated: boolean;
  /** The card on the Hub, for reading the rest of it. */
  url: string;
}

/**
 * Drop the YAML frontmatter a model card opens with.
 *
 * It carries licence and tag metadata for the Hub's own indexing, not anything
 * a person picking a quantization needs, and it would push the prose that
 * matters off the first screen.
 */
export function stripFrontmatter(markdown: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return m ? markdown.slice(m[0].length).replace(/^\s*\n/, '') : markdown;
}

const cache = new Map<string, RepoCard | null>();

/**
 * The card for a repo, or null when it has none (or the Hub won't say).
 *
 * A missing card is an ordinary outcome, not an error: plenty of repos ship
 * weights and nothing else, and the picker simply shows no card panel.
 * repoId/branch are interpolated into the URL, so callers must validate them.
 */
export async function fetchRepoCard(
  repoId: string,
  branch = 'main',
): Promise<RepoCard | null> {
  const key = `${repoId} ${branch}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const url = `https://huggingface.co/${repoId}`;
  let card: RepoCard | null = null;
  try {
    const res = await fetch(
      `https://huggingface.co/${repoId}/raw/${branch}/README.md`,
      {headers: HEADERS},
    );
    if (res.ok) {
      const body = stripFrontmatter(await res.text()).trim();
      if (body) {
        card = {
          markdown: body.slice(0, MAX_CHARS),
          truncated: body.length > MAX_CHARS,
          url,
        };
      }
    } else if (res.status !== 404) {
      logger.debug(`[hf] card ${repoId}@${branch}: HTTP ${res.status}`);
    }
  } catch (e) {
    logger.debug(`[hf] card ${repoId}@${branch} fetch failed:`, e);
  }
  cache.set(key, card);
  return card;
}
