#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * Requalification triggers: the inputs a runtime qualification was measured
 * under. A promoted catalog records them; a catalog whose recorded triggers
 * differ from the current source is older than its inputs and must be
 * requalified (or its runtimes withdrawn) before it ships.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonical, sha256 } from '../lib/cso/contracts';
import { ISOLATION_POLICY_HASH } from '../lib/cso/docker';
import { CSO_HELPER_ABI, isEvaluationRuntimeCatalog, type RequalificationTriggers, type RuntimeCatalog } from '../lib/cso/runtime-catalog';

const ROOT = path.resolve(import.meta.dir, '..');
/** Compiled into every runtime image as gstack-cso-verifier and gstack-cso-preparation. */
export const IMAGE_HELPER_ENTRYPOINTS = ['lib/cso/verifier.ts', 'lib/cso/preparation-container.ts'] as const;
export const IMAGE_CONTEXT = 'lib/cso/images';
/** Image-context files that describe qualification rather than enter an image; build-inputs.json is its own trigger. */
const IMAGE_CONTEXT_EXCLUDED = new Set(['README.md', 'qualification.json', 'build-inputs.json']);

/** Every repository file whose bytes enter a runtime image: the helpers' import closure plus the image build context. */
export async function imageSourceFiles(root = ROOT): Promise<string[]> {
  const build = await Bun.build({ entrypoints: IMAGE_HELPER_ENTRYPOINTS.map(entry => path.join(root, entry)), target: 'bun', metafile: true });
  if (!build.success || !build.metafile) throw new Error('REQUALIFICATION_SOURCE_CLOSURE_FAILED');
  // Bun reports metafile inputs relative to the process working directory, not to the entrypoints.
  const closure = Object.keys(build.metafile.inputs).map(input => path.relative(root, path.resolve(process.cwd(), input)).split(path.sep).join('/'));
  if (closure.some(file => file.startsWith('..') || file.includes('node_modules/'))) throw new Error('REQUALIFICATION_SOURCE_OUTSIDE_REPOSITORY');
  const context = fs.readdirSync(path.join(root, IMAGE_CONTEXT), { withFileTypes: true })
    .filter(entry => entry.isFile() && !IMAGE_CONTEXT_EXCLUDED.has(entry.name))
    .map(entry => `${IMAGE_CONTEXT}/${entry.name}`);
  return [...new Set([...closure, ...context])].sort();
}

export async function requalificationTriggers(root = ROOT): Promise<RequalificationTriggers> {
  const files = await imageSourceFiles(root);
  const buildInputs = JSON.parse(fs.readFileSync(path.join(root, IMAGE_CONTEXT, 'build-inputs.json'), 'utf8'));
  if (typeof buildInputs?.revision !== 'string' || !buildInputs.revision) throw new Error('INVALID_BUILD_INPUTS_REVISION');
  return {
    helperAbi: CSO_HELPER_ABI,
    isolationPolicyHash: ISOLATION_POLICY_HASH,
    preparationSha256: sha256(canonical(files.map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]))),
    buildInputsRevision: buildInputs.revision,
  };
}

/** Names of the triggers that changed since the catalog's runtimes were qualified; empty when nothing is promoted. */
export function staleRequalificationTriggers(catalog: RuntimeCatalog, current: RequalificationTriggers): string[] {
  if (isEvaluationRuntimeCatalog(catalog) || catalog.runtimes.length === 0) return [];
  const recorded = catalog.promotion?.requalification;
  if (!recorded) return Object.keys(current).sort();
  return (Object.keys(current) as Array<keyof RequalificationTriggers>).filter(key => recorded[key] !== current[key]).sort();
}

if (import.meta.main) {
  try {
    const [command, file, ...rest] = process.argv.slice(2);
    if (command === 'triggers' && file === undefined) {
      process.stdout.write(JSON.stringify(await requalificationTriggers(), null, 2) + '\n');
    } else if (command === 'check' && file && rest.length === 0) {
      const stale = staleRequalificationTriggers(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')), await requalificationTriggers());
      if (stale.length) throw new Error(`STALE_RUNTIME_QUALIFICATION: ${stale.join(', ')} changed since qualification; requalify the runtimes or withdraw them from the catalog`);
      process.stdout.write('REQUALIFICATION CURRENT\n');
    } else throw new Error('Usage: cso-requalification.ts triggers | check <runtime-catalog.json>');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'REQUALIFICATION_CHECK_FAILED') + '\n');
    process.exitCode = 1;
  }
}
