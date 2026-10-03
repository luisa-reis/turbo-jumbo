'use client';

import {Banner} from '@astryxdesign/core/Banner';
import {Code} from '@astryxdesign/core/Code';
import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {Heading} from '@astryxdesign/core/Heading';
import {List, ListItem} from '@astryxdesign/core/List';
import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {formatSize} from '@/lib/format/bytes';
import type {ServedBinary} from '@/lib/cli/served-binaries';

// The /cli page: how to put `tj` on another machine and point it here. Every
// command names this server by the origin the page was loaded from, so what
// it shows is exactly what to paste.
export function CliInstall({
  origin,
  binaries,
}: {
  origin: string;
  binaries: ServedBinary[];
}) {
  // The steps are shell commands, so they follow the first binary a Unix shell
  // can run; Windows builds, when there are any, are in the downloads list.
  const primary = binaries.find((b) => !b.target.startsWith('windows-'));
  const isMac = primary?.target.startsWith('darwin-') ?? false;
  const profile = isMac ? '~/.zshrc' : '~/.bashrc';

  return (
    <Section variant="transparent" padding={6} maxWidth={760}>
      <VStack gap={6}>
        <VStack gap={2}>
          <Heading level={1}>Command-line tool</Heading>
          <Text type="body" as="p">
            <Code>tj</Code> answers what this page does — which models you have,
            where each one lives, how full the disks are — from a terminal or a
            script, and can download, copy, audit and delete them too. It is a
            client of this server, built from the same commit it runs, so the
            two always agree.
          </Text>
        </VStack>

        {primary === undefined ? (
          <Banner
            status="warning"
            title="This server has no tj binaries to hand out"
            description={
              <>
                Deploys build them in. On a development checkout, run{' '}
                <Code>bin/build-cli.sh</Code> and reload this page.
              </>
            }
          />
        ) : (
          <>
            <VStack gap={2}>
              <Heading level={2}>1. Download it</Heading>
              <Text type="body" as="p">
                For {primary.platform}. It carries its own runtime, so nothing
                else needs installing.
              </Text>
              <CodeBlock
                language="bash"
                width="100%"
                code={[
                  'mkdir -p ~/bin',
                  `curl -fLo ~/bin/tj ${origin}${primary.path}`,
                  'chmod +x ~/bin/tj',
                ].join('\n')}
              />
            </VStack>

            <VStack gap={2}>
              <Heading level={2}>2. Point it at this server</Heading>
              <Text type="body" as="p">
                <Code>tj</Code> finds its server through <Code>TJ_URL</Code>.
                Add it to your shell profile, along with <Code>~/bin</Code> if
                that isn&apos;t on your <Code>PATH</Code> yet, then open a new
                terminal.
              </Text>
              <CodeBlock
                language="bash"
                width="100%"
                code={[
                  `echo 'export TJ_URL=${origin}' >> ${profile}`,
                  `echo 'export PATH="$HOME/bin:$PATH"' >> ${profile}`,
                ].join('\n')}
              />
            </VStack>

            <VStack gap={2}>
              <Heading level={2}>3. Try it</Heading>
              <Text type="body" as="p">
                <Code>tj version</Code> shows the server it reached and both
                versions; <Code>tj ls</Code> lists every model;{' '}
                <Code>tj --help</Code> lists everything else.
              </Text>
              <CodeBlock language="bash" width="100%" code="tj version" />
            </VStack>

            {isMac && (
              <Text type="body" as="p">
                Downloaded it with a browser instead of <Code>curl</Code>? macOS
                then quarantines it and refuses to open it; lift that with{' '}
                <Code>xattr -d com.apple.quarantine ~/bin/tj</Code>.
              </Text>
            )}
          </>
        )}

        {binaries.length > 0 && (
          <VStack gap={2}>
            <Heading level={2}>Downloads</Heading>
            <Text type="body" as="p">
              To check a download, compare{' '}
              <Code>
                {isMac ? 'shasum -a 256 ~/bin/tj' : 'sha256sum ~/bin/tj'}
              </Code>{' '}
              with its SHA-256 below.
            </Text>
            <List hasDividers>
              {binaries.map((b) => (
                <ListItem
                  key={b.name}
                  label={b.name}
                  href={b.path}
                  description={
                    <VStack gap={1}>
                      <Text type="supporting">
                        {b.platform} · {formatSize(b.size)}
                      </Text>
                      <Text type="code" size="xsm" color="secondary">
                        {b.sha256 ? `SHA-256 ${b.sha256}` : 'No checksum'}
                      </Text>
                    </VStack>
                  }
                />
              ))}
            </List>
          </VStack>
        )}
      </VStack>
    </Section>
  );
}
